import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'crypto';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { PrismaClient } from '@prisma/client';
import { WEBSOCKET_PATHS, MESSAGE_VERSION, HEARTBEAT_TIMEOUT_MS } from '@nexio/shared-types';

const LOG_FILE = '/tmp/nexio-debug.log';
function debugLog(msg: string) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

const PORT = parseInt(process.env.PORT || '10008');

const boardConnections = new Map<string, WebSocket>();
const clientConnections = new Map<string, WebSocket>();
const heartbeatTimers = new Map<string, NodeJS.Timeout>();
const boardCommandQueues = new Map<string, any[]>();
const monitorConnections = new Map<string, WebSocket>();
const boardLogs = new Map<string, any[]>();

const prisma = new PrismaClient();

function queueBoardCommand(boardId: string, cmd: any) {
  const existing = boardCommandQueues.get(boardId) || [];
  existing.push(cmd);
  boardCommandQueues.set(boardId, existing);
}

function sendToBoard(boardId: string, cmd: any) {
  const ws = boardConnections.get(boardId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(cmd));
  }
  queueBoardCommand(boardId, cmd);
}

function broadcastToMonitors(event: any) {
  const msg = JSON.stringify(event);
  monitorConnections.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

async function start() {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, { origin: true });

  fastify.get('/api/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  fastify.get('/api/boards', async () => {
    const boards = await prisma.board.findMany({
      orderBy: { connectedAt: 'desc' },
    });
    return boards;
  });

  fastify.get('/api/boards/:id', async (request: any, reply: any) => {
    const board = await prisma.board.findUnique({ where: { uniqueId: request.params.id } });
    if (!board) {
      return reply.status(404).send({ error: 'Board not found' });
    }
    const logs = boardLogs.get(board.uniqueId) || [];
    return { board, logs, connected: boardConnections.has(board.uniqueId) };
  });

  fastify.get('/api/boards/idle', async () => {
    const boards = await prisma.board.findMany({
      where: { status: 'IDLE' },
      orderBy: { connectedAt: 'desc' },
    });
    return boards;
  });

  fastify.get('/api/boards/onboarding', async (request: any) => {
    const { mac } = request.query;
    if (!mac) {
      return { error: 'MAC address is required' }, 400;
    }
    const board = await prisma.board.findFirst({
      where: { macAddress: mac },
    });
    if (board && (board.status === 'IDLE' || board.status === 'BUSY')) {
      return { registered: true, board: { uniqueId: board.uniqueId, status: board.status } };
    }
    return { registered: false };
  });

  fastify.get('/api/clients', async () => {
    const clients = await prisma.client.findMany({
      orderBy: { connectedAt: 'desc' },
    });
    return clients;
  });

  fastify.post('/api/onboarding/claim', async (request: any, reply: any) => {
    const { macAddress } = request.body;
    if (!macAddress) {
      return reply.status(400).send({ error: 'MAC address is required' });
    }

    const existingBoard = await prisma.board.findFirst({
      where: { macAddress },
    });
    if (existingBoard && existingBoard.uniqueId) {
      await prisma.board.update({
        where: { id: existingBoard.id },
        data: { status: 'CLAIMED' },
      });
      return { uniqueId: existingBoard.uniqueId };
    }

    const lastBoard = await prisma.board.findFirst({
      orderBy: { uniqueId: 'desc' },
      select: { uniqueId: true },
    });
    const nextNum = lastBoard ? parseInt(lastBoard.uniqueId, 10) + 1 : 1;
    const uniqueId = `${String(nextNum).padStart(4, '0')}`;

    try {
      await prisma.board.create({
        data: {
          uniqueId,
          macAddress,
          status: 'CLAIMED',
        },
      });
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.status(409).send({ error: 'Board already exists with this MAC or ID' });
      }
      throw err;
    }

    return { uniqueId };
  });

  fastify.post('/api/sessions', async (request: any) => {
    const { boardId, clientId, duration = 3600 } = request.body;

    const board = await prisma.board.findUnique({ where: { uniqueId: boardId } });
    if (!board || board.status !== 'IDLE') {
      return { error: 'Board not available' }, 404;
    }

    const client = await prisma.client.findUnique({ where: { clientId } });
    if (!client) {
      return { error: 'Client not found' }, 404;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + duration * 1000);

    const session = await prisma.session.create({
      data: {
        boardId: board.id,
        clientId: client.id,
        expiresAt,
      },
    });

    await prisma.board.update({
      where: { id: board.id },
      data: { status: 'BUSY' },
    });

    const boardWs = boardConnections.get(board.uniqueId);
    const clientWs = clientConnections.get(client.clientId);

    sendToBoard(board.uniqueId, {
      type: 'BOARD_READY',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      boardId: board.uniqueId,
      sessionId: session.id,
      assignedAt: now.getTime(),
      expiresAt: expiresAt.getTime(),
    });

    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'BOARD_READY',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        boardId: board.uniqueId,
        sessionId: session.id,
        assignedAt: now.getTime(),
        expiresAt: expiresAt.getTime(),
      }));
    }

    return session;
  });

  fastify.delete('/api/sessions/:id', async (request: any) => {
    const { id } = request.params;
    const session = await prisma.session.findUnique({ where: { id } });

    if (!session) {
      return { error: 'Session not found' }, 404;
    }

    await prisma.board.update({
      where: { id: session.boardId },
      data: { status: 'IDLE' },
    });

    await prisma.session.update({
      where: { id },
      data: { status: 'TERMINATED' },
    });

    const board = await prisma.board.findUnique({ where: { id: session.boardId } });
    if (board) {
      sendToBoard(board.uniqueId, {
        type: 'CONTROL',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        targetId: board.uniqueId,
        action: 'DISCONNECT',
        reason: 'session_terminated',
      });
    }

    return { success: true };
  });

  fastify.post('/api/boards/:id/discard', async (request: any) => {
    const { id } = request.params;

    const board = await prisma.board.findUnique({ where: { uniqueId: id } });
    if (!board) {
      return { error: 'Board not found' }, 404;
    }

    if (board.status === 'DISCARDED') {
      return { message: 'Already discarded' };
    }

    await prisma.board.update({
      where: { id: board.id },
      data: { status: 'DISCARDED' },
    });

    sendToBoard(id, {
      type: 'CONTROL',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      targetId: id,
      action: 'DISCARD',
      reason: 'board_discarded',
    });
    boardConnections.delete(id);

    return { success: true, discarded: true };
  });

  fastify.post('/api/control', async (request: any) => {
    const { targetId, action, type } = request.body;

    if (type === 'board') {
      const board = await prisma.board.findUnique({ where: { uniqueId: targetId } });
      if (board) {
        sendToBoard(targetId, {
          type: 'CONTROL',
          version: MESSAGE_VERSION,
          timestamp: Date.now(),
          targetId,
          action,
          reason: 'admin_request',
        });
      }
    } else if (type === 'client') {
      const ws = clientConnections.get(targetId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'CONTROL',
          version: MESSAGE_VERSION,
          timestamp: Date.now(),
          targetId,
          action,
          reason: 'admin_request',
        }));
      }
    }

    return { success: true };
  });

  fastify.post('/api/board/message', async (request: any, reply) => {
    const msg = request.body;
    const { type, boardId: macAddr, firmwareVersion, displayAvailable, sessionId, payload, direction, id, uniqueId: preAssignedId, sourceId } = msg;
    const commands: any[] = [];

    if (type === 'REGISTER') {
      let uniqueId: string;

      if (preAssignedId) {
        const claimed = await prisma.board.findUnique({ where: { uniqueId: preAssignedId } });
        if (claimed) {
          if (claimed.status === 'DISCARDED') {
            await prisma.board.delete({ where: { id: claimed.id } });
          } else {
            uniqueId = claimed.uniqueId;
            await prisma.board.updateMany({
              where: { macAddress: macAddr, NOT: { id: claimed.id } },
              data: { macAddress: null },
            });
            await prisma.board.update({
              where: { id: claimed.id },
              data: { firmwareVersion, displayAvailable, status: 'IDLE', connectedAt: new Date() },
            });
          }
        }
        if (!claimed || claimed.status === 'DISCARDED') {
          uniqueId = preAssignedId;
          await prisma.board.create({
            data: { uniqueId, macAddress: macAddr, firmwareVersion, displayAvailable, status: 'IDLE' },
          });
        }
      } else {
        const existingBoard = await prisma.board.findFirst({ where: { macAddress: macAddr } });
        if (existingBoard) {
          if (existingBoard.status === 'DISCARDED') {
            await prisma.board.delete({ where: { id: existingBoard.id } });
          } else {
            uniqueId = existingBoard.uniqueId;
            await prisma.board.update({
              where: { id: existingBoard.id },
              data: { status: 'IDLE', connectedAt: new Date() },
            });
          }
        }
        if (!existingBoard || existingBoard.status === 'DISCARDED') {
          const lastBoard = await prisma.board.findFirst({
            orderBy: { uniqueId: 'desc' },
            select: { uniqueId: true },
          });
          const nextNum = lastBoard ? parseInt(lastBoard.uniqueId, 10) + 1 : 1;
          uniqueId = `${String(nextNum).padStart(4, '0')}`;
          await prisma.board.create({
            data: { uniqueId, macAddress: macAddr, firmwareVersion, displayAvailable, status: 'IDLE' },
          });
        }
      }

      const pending = boardCommandQueues.get(uniqueId) || [];
      boardCommandQueues.delete(uniqueId);
      commands.push(...pending);

      commands.push({ type: 'ASSIGN_ID', version: MESSAGE_VERSION, timestamp: Date.now(), uniqueId, serverTime: Date.now() });

      startHeartbeatTimer(uniqueId);

      return { commands, uniqueId };
    }

    if (type === 'HEARTBEAT') {
      const boardId = id || preAssignedId;
      if (boardId) {
        resetHeartbeatTimer(boardId);
        const pending = boardCommandQueues.get(boardId) || [];
        boardCommandQueues.delete(boardId);
        commands.push(...pending);
      }
      return { commands };
    }

    if (type === 'DISCARD_ACK') {
      const boardId = id;
      if (boardId) {
        await prisma.board.delete({ where: { uniqueId: boardId } }).catch(() => {});
        boardCommandQueues.delete(boardId);
        boardConnections.delete(boardId);
        clearHeartbeatTimer(boardId);
      }
      return { success: true };
    }

    if (type === 'DATA_RELAY' && sessionId) {
      const boardUniqueId = sourceId || id || macAddr;
      if (boardUniqueId) resetHeartbeatTimer(boardUniqueId);
      const session = await prisma.session.findUnique({ where: { id: sessionId } });
      if (session) {
        const client = await prisma.client.findUnique({ where: { id: session.clientId } });
        if (client) {
          const clientWs = clientConnections.get(client.clientId);
          if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            const relayMsg = {
              type: 'DATA_RELAY', version: MESSAGE_VERSION, timestamp: Date.now(),
              sessionId, sourceId: macAddr || id, direction, payload,
            };
            clientWs.send(JSON.stringify(relayMsg));
            broadcastToMonitors({ boardId: boardUniqueId, ...relayMsg });
          }
        }
      }
      return { commands };
    }

    if (type === 'LOG') {
      const boardUniqueId = id || sourceId;
      if (boardUniqueId) {
        resetHeartbeatTimer(boardUniqueId);
        const entry = { timestamp: Date.now(), level: msg.level || 'info', message: msg.message, data: msg.data };
        const logs = boardLogs.get(boardUniqueId) || [];
        logs.push(entry);
        if (logs.length > 500) logs.shift();
        boardLogs.set(boardUniqueId, logs);
        broadcastToMonitors({ boardId: boardUniqueId, type: 'LOG', ...entry });
      }
      return { commands };
    }

    return { commands };
  });

  fastify.get('/api/users', async () => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, username: true, email: true, orgName: true, active: true, clientId: true, createdAt: true },
    });
    return users;
  });

  fastify.post('/api/users/:id/toggle', async (request: any) => {
    const { id } = request.params;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return { error: 'User not found' }, 404;
    const updated = await prisma.user.update({
      where: { id },
      data: { active: !user.active },
    });
    return { id: updated.id, active: updated.active };
  });

  fastify.post('/api/auth/register', async (request: any) => {
    const { username, password, email, orgName } = request.body;
    if (!username || !password) {
      return { error: 'Username and password required' }, 400;
    }
    if (username.length < 3) {
      return { error: 'Username must be at least 3 characters' }, 400;
    }
    if (password.length < 4) {
      return { error: 'Password must be at least 4 characters' }, 400;
    }

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return { error: 'Username already taken' }, 409;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const hashed = `${salt}:${hash}`;
    const token = crypto.randomUUID();

    const user = await prisma.user.create({
      data: { username, password: hashed, email: email || null, orgName: orgName || null, token },
    });

    return { userId: user.id, username: user.username, email: user.email, orgName: user.orgName, token: user.token };
  });

  fastify.post('/api/auth/login', async (request: any) => {
    const { username, password } = request.body;
    if (!username || !password) {
      return { error: 'Username and password required' }, 400;
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return { error: 'Invalid username or password' }, 401;
    }
    if (!user.active) {
      return { error: 'Account is deactivated' }, 403;
    }

    const [salt, storedHash] = user.password.split(':');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    if (hash !== storedHash) {
      return { error: 'Invalid username or password' }, 401;
    }

    if (!user.token) {
      const token = crypto.randomUUID();
      await prisma.user.update({ where: { id: user.id }, data: { token } });
      return { userId: user.id, username: user.username, email: user.email, orgName: user.orgName, token };
    }

    return { userId: user.id, username: user.username, email: user.email, orgName: user.orgName, token: user.token };
  });

  const wss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });
  const monitorWss = new WebSocketServer({ noServer: true });

  fastify.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === WEBSOCKET_PATHS.BOARD) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (url.pathname === WEBSOCKET_PATHS.CLIENT) {
      clientWss.handleUpgrade(request, socket, head, (ws) => {
        clientWss.emit('connection', ws, request);
      });
    } else if (url.pathname === WEBSOCKET_PATHS.MONITOR) {
      monitorWss.handleUpgrade(request, socket, head, (ws) => {
        monitorWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws, req) => {
    debugLog(`Board WS connected from ${req.socket.remoteAddress}`);
    let boardId: string | null = null;

    ws.on('error', (err) => {
      debugLog(`Board WS error: ${err}`);
    });

    ws.on('message', async (data) => {
      try {
        debugLog(`Board WS raw: ${data.toString().substring(0, 200)}`);
        const msg = JSON.parse(data.toString());
        debugLog(`Board WS parsed: type=${msg.type}, boardId=${msg.boardId}, preAssignedId=${msg.uniqueId}`);
        await handleBoardMessage(ws, msg, (id) => { boardId = id; });
      } catch (err) {
        debugLog(`Board message error: ${err}`);
        console.error('Board message error:', err);
      }
    });

    ws.on('close', async (code, reason) => {
      debugLog(`Board WS close: code=${code}, reason=${reason ? reason.toString() : 'none'}`);
      if (boardId) {
        boardConnections.delete(boardId!);
        clearHeartbeatTimer(boardId!);
        await prisma.board.updateMany({
          where: { uniqueId: boardId },
          data: { status: 'OFFLINE' },
        });
      }
    });
  });

  clientWss.on('connection', (ws, req) => {
    let clientId: string | null = null;

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await handleClientMessage(ws, msg, (id) => { clientId = id; });
      } catch (err) {
        console.error('Client message error:', err);
      }
    });

    ws.on('close', async () => {
      if (clientId) {
        clientConnections.delete(clientId!);
        clearHeartbeatTimer(clientId!);
        await prisma.client.updateMany({
          where: { clientId: clientId },
          data: { status: 'DISCONNECTED' },
        });
      }
    });
  });

  monitorWss.on('connection', (ws, req) => {
    const monitorId = crypto.randomUUID();
    monitorConnections.set(monitorId, ws);
    debugLog(`Monitor WS connected from ${req.socket.remoteAddress}`);
    ws.on('close', () => {
      monitorConnections.delete(monitorId);
      debugLog('Monitor WS disconnected');
    });
    ws.on('error', (err) => debugLog(`Monitor WS error: ${err}`));
  });

  await fastify.listen({ port: PORT, host: '0.0.0.0' });

  await prisma.board.updateMany({
    where: { status: { in: ['IDLE', 'BUSY'] } },
    data: { status: 'OFFLINE' },
  });

  setInterval(checkExpiredSessions, 60000);
}

async function handleBoardMessage(ws: WebSocket, msg: any, setBoardId: (id: string) => void) {
  try {
  const { type, boardId, firmwareVersion, displayAvailable, sessionId, payload, direction, id, uniqueId: preAssignedId } = msg;

  if (type === 'REGISTER') {
    let uniqueId: string;

    if (preAssignedId) {
      const claimed = await prisma.board.findUnique({
        where: { uniqueId: preAssignedId },
      });
      if (claimed) {
        if (claimed.status === 'DISCARDED') {
          await prisma.board.delete({ where: { id: claimed.id } });
        } else {
          uniqueId = claimed.uniqueId;
          await prisma.board.updateMany({
            where: { macAddress: boardId, NOT: { id: claimed.id } },
            data: { macAddress: null },
          });
          await prisma.board.update({
            where: { id: claimed.id },
            data: {
              firmwareVersion,
              displayAvailable,
              status: 'IDLE',
              connectedAt: new Date(),
            },
          });
        }
      }
      if (!claimed || claimed.status === 'DISCARDED') {
        uniqueId = preAssignedId;
        await prisma.board.create({
          data: {
            uniqueId,
            macAddress: boardId,
            firmwareVersion,
            displayAvailable,
            status: 'IDLE',
          },
        });
      }
    } else {
      const existingBoard = await prisma.board.findFirst({
        where: { macAddress: boardId },
      });

      if (existingBoard) {
        if (existingBoard.status === 'DISCARDED') {
          await prisma.board.delete({ where: { id: existingBoard.id } });
        } else {
          uniqueId = existingBoard.uniqueId;
          await prisma.board.update({
            where: { id: existingBoard.id },
            data: { status: 'IDLE', connectedAt: new Date() },
          });
        }
      }
      if (!existingBoard || existingBoard.status === 'DISCARDED') {
        const lastBoard = await prisma.board.findFirst({
          orderBy: { uniqueId: 'desc' },
          select: { uniqueId: true },
        });
        const nextNum = lastBoard ? parseInt(lastBoard.uniqueId, 10) + 1 : 1;
        uniqueId = `${String(nextNum).padStart(4, '0')}`;
        await prisma.board.create({
          data: {
            uniqueId,
            macAddress: boardId,
            firmwareVersion,
            displayAvailable,
            status: 'IDLE',
          },
        });
      }
    }

    setBoardId(uniqueId);
    boardConnections.set(uniqueId, ws);

    ws.send(JSON.stringify({
      type: 'ASSIGN_ID',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      uniqueId,
      serverTime: Date.now(),
    }));

    startHeartbeatTimer(uniqueId);
  }

  if (type === 'HEARTBEAT') {
    resetHeartbeatTimer(id || msg.uniqueId);
    ws.send(JSON.stringify({
      type: 'HEARTBEAT',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      id: id || msg.uniqueId,
    }));
  }

  if (type === 'DATA_RELAY' && sessionId) {
    const boardUniqueId = id || boardId;
    if (boardUniqueId) resetHeartbeatTimer(boardUniqueId);
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (session) {
      const client = await prisma.client.findUnique({ where: { id: session.clientId } });
      if (client) {
        const clientWs = clientConnections.get(client.clientId);
        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'DATA_RELAY',
            version: MESSAGE_VERSION,
            timestamp: Date.now(),
            sessionId,
            sourceId: msg.uniqueId || boardId,
            direction,
            payload,
          }));
          broadcastToMonitors({ boardId: boardUniqueId, type: 'DATA_RELAY', sessionId, sourceId: msg.uniqueId || boardId, direction, payload });
        }
      }
    }
  }

  if (type === 'LOG') {
    const boardUniqueId = id || boardId;
    if (boardUniqueId) {
      resetHeartbeatTimer(boardUniqueId);
      const entry = { timestamp: Date.now(), level: msg.level || 'info', message: msg.message, data: msg.data };
      const logs = boardLogs.get(boardUniqueId) || [];
      logs.push(entry);
      if (logs.length > 500) logs.shift();
      boardLogs.set(boardUniqueId, logs);
      broadcastToMonitors({ boardId: boardUniqueId, type: 'LOG', ...entry });
    }
  }
  } catch (err) {
    console.error(`[handleBoardMessage] Error:`, err);
    ws.close(1011, 'Internal error');
  }
}

  async function handleClientMessage(ws: WebSocket, msg: any, setClientId: (id: string) => void) {
  const { type, clientId, sessionDuration, sessionId, payload, direction, id, token, userId: msgUserId } = msg;

  if (type === 'REQUEST_BOARD') {
    let resolvedUserId: string | undefined;

    if (token) {
      const user = await prisma.user.findUnique({ where: { token } });
      if (user) resolvedUserId = user.id;
    }

    const newClientId = clientId || resolvedUserId || `CLIENT-${Date.now()}`;

    let client = await prisma.client.findUnique({ where: { clientId: newClientId } });
    if (!client) {
      client = await prisma.client.create({
        data: { clientId: newClientId, userId: resolvedUserId, status: 'CONNECTED' },
      });
    } else {
      await prisma.client.update({
        where: { id: client.id },
        data: { status: 'CONNECTED', userId: resolvedUserId, connectedAt: new Date() },
      });
    }

    if (resolvedUserId) {
      await prisma.user.update({
        where: { id: resolvedUserId },
        data: { clientId: newClientId },
      });
    }

    setClientId(newClientId);
    clientConnections.set(newClientId, ws);

    // Send user info back to client
    ws.send(JSON.stringify({
      type: 'AUTH_INFO',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      userId: resolvedUserId,
      clientId: newClientId,
    }));

    const idleBoards = await prisma.board.findMany({ where: { status: 'IDLE' } });

    if (idleBoards.length === 0) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        code: 'BOARD_NOT_FOUND',
        message: 'No idle boards available',
      }));
      return;
    }

    const board = idleBoards[0];
    const duration = sessionDuration || 3600;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + duration * 1000);

    const session = await prisma.session.create({
      data: {
        boardId: board.id,
        clientId: client.id,
        expiresAt,
      },
    });

    await prisma.board.update({
      where: { id: board.id },
      data: { status: 'BUSY' },
    });

    const boardWs = boardConnections.get(board.uniqueId);

    sendToBoard(board.uniqueId, {
      type: 'BOARD_READY',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      boardId: board.uniqueId,
      sessionId: session.id,
      assignedAt: now.getTime(),
      expiresAt: expiresAt.getTime(),
    });

    ws.send(JSON.stringify({
      type: 'BOARD_READY',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      boardId: board.uniqueId,
      sessionId: session.id,
      assignedAt: now.getTime(),
      expiresAt: expiresAt.getTime(),
    }));

    startHeartbeatTimer(newClientId);
  }

  if (type === 'HEARTBEAT') {
    resetHeartbeatTimer(id || clientId);
    ws.send(JSON.stringify({
      type: 'HEARTBEAT',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      id: id || clientId,
    }));
  }

  if (type === 'DATA_RELAY' && sessionId) {
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (session) {
      const board = await prisma.board.findUnique({ where: { id: session.boardId } });
      if (board) {
        sendToBoard(board.uniqueId, {
          type: 'DATA_RELAY',
          version: MESSAGE_VERSION,
          timestamp: Date.now(),
          sessionId,
          sourceId: clientId || id,
          direction,
          payload,
        });
      }
    }
  }
}

function startHeartbeatTimer(id: string) {
  clearHeartbeatTimer(id);
  const timer = setTimeout(async () => {
    console.log(`Heartbeat timeout for ${id}`);
    const board = await prisma.board.findUnique({ where: { uniqueId: id } });
    if (board) {
      await prisma.board.update({
        where: { id: board.id },
        data: { status: 'OFFLINE' },
      });
    }
    const ws = boardConnections.get(id);
    if (ws) ws.close();
    boardConnections.delete(id);
    // If board was HTTP-based, it's fine — it'll reconnect on next heartbeat
  }, HEARTBEAT_TIMEOUT_MS);
  heartbeatTimers.set(id, timer);
}

function resetHeartbeatTimer(id: string) {
  startHeartbeatTimer(id);
}

function clearHeartbeatTimer(id: string) {
  const timer = heartbeatTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    heartbeatTimers.delete(id);
  }
}

async function checkExpiredSessions() {
  const now = new Date();
  const expiredSessions = await prisma.session.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { lt: now },
    },
    include: { board: true, client: true },
  });

  for (const session of expiredSessions) {
    await prisma.session.update({
      where: { id: session.id },
      data: { status: 'EXPIRED' },
    });

    await prisma.board.update({
      where: { id: session.boardId },
      data: { status: 'IDLE' },
    });

    sendToBoard(session.board.uniqueId, {
      type: 'CONTROL',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      targetId: session.board.uniqueId,
      action: 'DISCONNECT',
      reason: 'session_expired',
    });

    const clientWs = clientConnections.get(session.client.clientId);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'ERROR',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        code: 'SESSION_EXPIRED',
        message: 'Your session has expired',
      }));
    }
  }
}

start().catch(console.error);
