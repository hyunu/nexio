import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
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

async function notifyClientsBoardDiscarded(boardId: string) {
  const sessions = await prisma.session.findMany({
    where: { board: { uniqueId: boardId }, status: 'ACTIVE' },
    include: { client: true },
  });
  for (const session of sessions) {
    await prisma.session.update({
      where: { id: session.id },
      data: { status: 'TERMINATED' },
    });
    const clientWs = clientConnections.get(session.client.clientId);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'END_SESSION',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        sessionId: session.id,
        reason: 'board_discarded',
      }));
    }
  }
}
const boardCommandQueues = new Map<string, any[]>();
const monitorConnections = new Map<string, WebSocket>();
const boardLogs = new Map<string, any[]>();
const discardAckWaiters = new Map<string, { resolve: (v: boolean) => void; timer: NodeJS.Timeout }>();

const prisma = new PrismaClient();

function queueBoardCommand(boardId: string, cmd: any) {
  const existing = boardCommandQueues.get(boardId) || [];
  existing.push(cmd);
  boardCommandQueues.set(boardId, existing);
}

function waitForDiscardAck(boardId: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      discardAckWaiters.delete(boardId);
      resolve(false);
    }, timeoutMs);
    discardAckWaiters.set(boardId, { resolve, timer });
  });
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
  // Serve built frontend if available (apps/web/dist)
  try {
    // Use process.cwd() to reliably locate built frontend in the container
    const staticDir = path.join(process.cwd(), 'apps', 'web', 'dist');
    if (fs.existsSync(staticDir)) {
      await fastify.register(fastifyStatic, {
        root: staticDir,
        prefix: '/',
      });
      // SPA fallback: serve index.html for unknown GET routes
      fastify.setNotFoundHandler((request: any, reply: any) => {
        if (request.raw.method === 'GET') {
          return reply.sendFile('index.html');
        }
        return reply.callNotFound();
      });
    }
  } catch (err) {
    console.error('Error registering static assets:', err);
  }

  fastify.get('/api/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  fastify.post('/api/echo', async (request: any, reply: any) => {
    return {
      method: 'POST',
      path: '/api/echo',
      body: request.body,
      query: request.query,
      timestamp: Date.now(),
    };
  });

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

  fastify.get('/api/boards/onboarding', async (request: any, reply: any) => {
    const { mac } = request.query;
    if (!mac) {
      return reply.status(400).send({ error: 'MAC address is required' });
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
      include: { user: { select: { username: true } } },
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

  fastify.get('/api/sessions', async () => {
    const sessions = await prisma.session.findMany({
      include: { board: { select: { uniqueId: true } }, client: { select: { clientId: true } } },
      orderBy: { assignedAt: 'desc' },
      take: 100,
    });
    return sessions;
  });

  fastify.post('/api/sessions', async (request: any, reply: any) => {
    const { boardId, clientId, duration = 3600 } = request.body;

    const board = await prisma.board.findUnique({ where: { uniqueId: boardId } });
    if (!board || board.status !== 'IDLE') {
      return reply.status(404).send({ error: 'Board not available' });
    }

    const client = await prisma.client.findUnique({ where: { clientId } });
    if (!client) {
      return reply.status(404).send({ error: 'Client not found' });
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
        productConnected: board.productConnected,
      }));
    }

    return session;
  });

  fastify.delete('/api/sessions/:id', async (request: any, reply: any) => {
    const { id } = request.params;
    const session = await prisma.session.findUnique({ where: { id } });

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
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

  fastify.post('/api/boards/:id/discard', async (request: any, reply: any) => {
    const { id } = request.params;

    const board = await prisma.board.findUnique({ where: { uniqueId: id } });
    if (!board) {
      return reply.status(404).send({ error: 'Board not found' });
    }

    sendToBoard(id, {
      type: 'CONTROL',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      targetId: id,
      action: 'DISCARD',
      reason: 'admin_discard',
    });

    const ackReceived = await waitForDiscardAck(id, 5000);

    await notifyClientsBoardDiscarded(id);
    await prisma.board.update({ where: { uniqueId: id }, data: { status: 'DISCARDED' } }).catch(() => {});
    boardCommandQueues.delete(id);
    boardConnections.delete(id);
    clearHeartbeatTimer(id);

    return { success: true, discarded: true, ackReceived };
  });

  fastify.post('/api/boards/discard-by-mac', async (request: any, reply: any) => {
    const { macAddress } = request.body;
    if (!macAddress) {
      return reply.status(400).send({ error: 'MAC address is required' });
    }
    const board = await prisma.board.findFirst({ where: { macAddress } });
    if (!board) {
      return reply.status(404).send({ error: 'Board not found' });
    }
    const id = board.uniqueId;
    await notifyClientsBoardDiscarded(id);
    await prisma.board.update({ where: { id: board.id }, data: { status: 'DISCARDED' } }).catch(() => {});
    boardCommandQueues.delete(id);
    boardConnections.delete(id);
    clearHeartbeatTimer(id);
    return { success: true, discarded: true };
  });

  fastify.patch('/api/boards/:id', async (request: any, reply: any) => {
    const { id } = request.params;
    const { location } = request.body;

    const board = await prisma.board.findUnique({ where: { uniqueId: id } });
    if (!board) {
      return reply.status(404).send({ error: 'Board not found' });
    }

    await prisma.board.update({
      where: { uniqueId: id },
      data: { location },
    });

    return { success: true };
  });

  fastify.post('/api/control', async (request: any) => {
    const { targetId, action, type, payload } = request.body;

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
          type: action === 'PING' ? 'PING' : 'CONTROL',
          version: MESSAGE_VERSION,
          timestamp: Date.now(),
          targetId,
          action,
          reason: 'admin_request',
          payload,
        }));

        if (action === 'PING') {
          return { success: true, reachable: true, message: '핑 전송 성공' };
        }

        if (action === 'DISCONNECT') {
          ws.close();
          await prisma.client.updateMany({
            where: { clientId: targetId },
            data: { status: 'DISCONNECTED' },
          });
          clientConnections.delete(targetId);
          clearHeartbeatTimer(targetId);
        }
      } else {
        if (action === 'PING') return { success: true, reachable: false, message: '클라이언트 연결 안됨' };
        return { success: false, error: 'Client not connected' };
      }
    }

    return { success: true };
  });

  fastify.post('/api/sessions/:id/terminate', async (request: any, reply: any) => {
    const { id } = request.params;
    const session = await prisma.session.findUnique({
      where: { id },
      include: { board: true, client: true },
    });
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    await prisma.session.update({
      where: { id },
      data: { status: 'TERMINATED' },
    });
    await prisma.board.update({
      where: { id: session.board.id },
      data: { status: 'IDLE' },
    });

    const clientWs = clientConnections.get(session.client.clientId);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'CONTROL',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        action: 'SESSION_TERMINATED',
        reason: 'admin_request',
        sessionId: id,
      }));
    }

    const boardData = await prisma.board.findUnique({ where: { id: session.board.id } });
    if (boardData?.wsConnection) {
      sendToBoard(session.board.uniqueId, {
        type: 'END_SESSION',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        sessionId: id,
        reason: 'admin_request',
      });
    }

    return { success: true };
  });

  fastify.post('/api/board/message', async (request: any, reply) => {
    const msg = request.body;
    const { type, boardId: macAddr, firmwareVersion, displayAvailable, sessionId, payload, direction, id, uniqueId: preAssignedId, sourceId, productConnected } = msg;
    const commands: any[] = [];

    if (type === 'REGISTER') {
      let uniqueId!: string;

      if (preAssignedId) {
        const claimed = await prisma.board.findUnique({ where: { uniqueId: preAssignedId } });
        if (claimed) {
          uniqueId = claimed.uniqueId;
          await prisma.board.updateMany({
            where: { macAddress: macAddr, NOT: { id: claimed.id } },
            data: { macAddress: null },
          });
          await prisma.board.update({
            where: { id: claimed.id },
            data: { firmwareVersion, displayAvailable, productConnected: productConnected ?? false, status: 'IDLE', connectedAt: new Date(), wifiMac: macAddr },
          });
        }
        if (!claimed) {
          uniqueId = preAssignedId;
          await prisma.board.create({
            data: { uniqueId, macAddress: macAddr, wifiMac: macAddr, firmwareVersion, displayAvailable, productConnected: productConnected ?? false, status: 'IDLE' },
          });
        }
      } else {
        const existingBoard = await prisma.board.findFirst({ where: { macAddress: macAddr } });
        if (existingBoard) {
          uniqueId = existingBoard.uniqueId;
          await prisma.board.update({
            where: { id: existingBoard.id },
            data: { macAddress: macAddr, wifiMac: macAddr, productConnected: productConnected ?? false, status: 'IDLE', connectedAt: new Date() },
          });
        }
        if (!existingBoard) {
          const lastBoard = await prisma.board.findFirst({
            orderBy: { uniqueId: 'desc' },
            select: { uniqueId: true },
          });
          const nextNum = lastBoard ? parseInt(lastBoard.uniqueId, 10) + 1 : 1;
          uniqueId = `${String(nextNum).padStart(4, '0')}`;
          await prisma.board.create({
            data: { uniqueId, macAddress: macAddr, wifiMac: macAddr, firmwareVersion, displayAvailable, productConnected: productConnected ?? false, status: 'IDLE' },
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
        await prisma.board.update({ where: { uniqueId: boardId }, data: { status: 'DISCARDED' } }).catch(() => {});
        boardCommandQueues.delete(boardId);
        boardConnections.delete(boardId);
        clearHeartbeatTimer(boardId);
        const waiter = discardAckWaiters.get(boardId);
        if (waiter) {
          clearTimeout(waiter.timer);
          discardAckWaiters.delete(boardId);
          waiter.resolve(true);
        }
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
      select: { id: true, username: true, email: true, orgName: true, active: true, admin: true, clientId: true, createdAt: true },
    });
    return users;
  });

  fastify.post('/api/users/:id/toggle', async (request: any, reply: any) => {
    const { id } = request.params;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.status(404).send({ error: 'User not found' });
    const updated = await prisma.user.update({
      where: { id },
      data: { active: !user.active },
    });
    return { id: updated.id, active: updated.active };
  });

  fastify.post('/api/users/:id/toggle-admin', async (request: any, reply: any) => {
    const { id } = request.params;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.status(404).send({ error: 'User not found' });
    const updated = await prisma.user.update({
      where: { id },
      data: { admin: !user.admin },
    });
    return { id: updated.id, admin: updated.admin };
  });

  fastify.post('/api/auth/register', async (request: any, reply: any) => {
    const { username, password, email, orgName } = request.body;
    if (!username || !password) {
      return reply.status(400).send({ error: 'Username and password required' });
    }
    if (username.length < 3) {
      return reply.status(400).send({ error: 'Username must be at least 3 characters' });
    }
    if (password.length < 4) {
      return reply.status(400).send({ error: 'Password must be at least 4 characters' });
    }

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return reply.status(409).send({ error: 'Username already taken' });
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

  fastify.post('/api/auth/login', async (request: any, reply: any) => {
    const { username, password } = request.body;
    if (!username || !password) {
      return reply.status(400).send({ error: 'Username and password required' });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return reply.status(401).send({ error: 'Invalid username or password' });
    }
    if (!user.active) {
      return reply.status(403).send({ error: 'Account is deactivated' });
    }

    const [salt, storedHash] = user.password.split(':');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    if (hash !== storedHash) {
      return reply.status(401).send({ error: 'Invalid username or password' });
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
        if (boardConnections.get(boardId!) === ws) {
          boardConnections.delete(boardId!);
          clearHeartbeatTimer(boardId!);
          await prisma.board.updateMany({
            where: { uniqueId: boardId },
            data: { status: 'OFFLINE' },
          });
          const sessions = await prisma.session.findMany({
            where: { board: { uniqueId: boardId }, status: 'ACTIVE' },
            include: { client: true },
          });
          for (const session of sessions) {
            await prisma.session.update({
              where: { id: session.id },
              data: { status: 'TERMINATED' },
            });
            const clientWs = clientConnections.get(session.client.clientId);
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'END_SESSION',
                version: MESSAGE_VERSION,
                timestamp: Date.now(),
                sessionId: session.id,
                reason: 'board_disconnected',
              }));
            }
          }
        }
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
        const client = await prisma.client.findUnique({ where: { clientId } });
        if (client) {
          const sessions = await prisma.session.findMany({
            where: { clientId: client.id, status: 'ACTIVE' },
            include: { board: true },
          });
          for (const s of sessions) {
            await prisma.session.update({
              where: { id: s.id },
              data: { status: 'TERMINATED' },
            });
            sendToBoard(s.board.uniqueId, {
              type: 'CONTROL',
              version: MESSAGE_VERSION,
              timestamp: Date.now(),
              action: 'DISCONNECT',
              reason: 'client_disconnected',
            });
            await prisma.board.update({
              where: { id: s.board.id },
              data: { status: 'IDLE' },
            });
          }
        }
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
  const { type, boardId, firmwareVersion, displayAvailable, sessionId, payload, direction, id, uniqueId: preAssignedId, productConnected } = msg;

  if (type === 'REGISTER') {
    let uniqueId!: string;

    if (preAssignedId) {
      const claimed = await prisma.board.findUnique({
        where: { uniqueId: preAssignedId },
      });
      if (claimed) {
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
            productConnected: productConnected ?? false,
            status: 'IDLE',
            connectedAt: new Date(),
            wifiMac: boardId,
          },
        });
      }
      if (!claimed) {
        uniqueId = preAssignedId;
        await prisma.board.create({
          data: {
            uniqueId,
            macAddress: boardId,
            wifiMac: boardId,
            firmwareVersion,
            displayAvailable,
            productConnected: productConnected ?? false,
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
            data: { productConnected: productConnected ?? false, status: 'IDLE', connectedAt: new Date(), wifiMac: boardId },
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
            wifiMac: boardId,
            firmwareVersion,
            displayAvailable,
            productConnected: productConnected ?? false,
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
    const boardUniqueId = id || msg.uniqueId;
    if (boardUniqueId) {
      resetHeartbeatTimer(boardUniqueId);
      // Propagate productConnected changes
      if (typeof msg.productConnected === 'boolean') {
        const board = await prisma.board.findUnique({ where: { uniqueId: boardUniqueId } });
        if (board && board.productConnected !== msg.productConnected) {
          await prisma.board.update({
            where: { id: board.id },
            data: { productConnected: msg.productConnected },
          });
          // Notify all active session clients
          const sessions = await prisma.session.findMany({
            where: { boardId: board.id, status: 'ACTIVE' },
            include: { client: true },
          });
          for (const s of sessions) {
            const clientWs = clientConnections.get(s.client.clientId);
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'PRODUCT_STATUS',
                version: MESSAGE_VERSION,
                timestamp: Date.now(),
                sessionId: s.id,
                boardId: boardUniqueId,
                connected: msg.productConnected,
              }));
            }
          }
        }
      }
    }
    ws.send(JSON.stringify({
      type: 'HEARTBEAT',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      id: boardUniqueId,
    }));
  }

  if (type === 'DATA_RELAY') {
    const boardUniqueId = id || boardId;
    if (boardUniqueId) resetHeartbeatTimer(boardUniqueId);

    // Normalize board→client: hex or base64 payload → base64, direction → B_TO_C
    const isBoardToServer = direction === 'uart_to_server' || direction === 'B_TO_C';
    const clientPayload = (isBoardToServer && payload && /^[0-9A-Fa-f]+$/.test(payload))
      ? Buffer.from(payload, 'hex').toString('base64')
      : payload;
    const clientDirection = isBoardToServer ? 'B_TO_C' : direction;

    if (sessionId) {
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
              direction: clientDirection,
              payload: clientPayload,
              hexDisplay: isBoardToServer ? payload : undefined,
            }));
          }
        }
      }
    } else if (boardUniqueId) {
      const sessions = await prisma.session.findMany({
        where: { board: { uniqueId: boardUniqueId }, status: 'ACTIVE' },
        include: { client: true },
      });
      for (const s of sessions) {
        const clientWs = clientConnections.get(s.client.clientId);
        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'DATA_RELAY',
            version: MESSAGE_VERSION,
            timestamp: Date.now(),
            sessionId: s.id,
            sourceId: boardUniqueId,
            direction: clientDirection,
            payload: clientPayload,
            hexDisplay: isBoardToServer ? payload : undefined,
          }));
        }
      }
    }

    if (boardUniqueId) {
      broadcastToMonitors({ boardId: boardUniqueId, type: 'DATA_RELAY', timestamp: Date.now(), sessionId, sourceId: msg.uniqueId || boardId, direction, payload, hexDisplay: isBoardToServer ? payload : undefined });
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

  if (type === 'DISCARD_ACK') {
    const boardId = id || msg.uniqueId;
    if (boardId) {
      const waiter = discardAckWaiters.get(boardId);
      if (waiter) {
        debugLog(`DISCARD_ACK received for ${boardId}`);
        waiter.resolve(true);
        clearTimeout(waiter.timer);
        discardAckWaiters.delete(boardId);
      }
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
    if (!client && resolvedUserId) {
      client = await prisma.client.findFirst({ where: { userId: resolvedUserId } });
    }
    if (!client) {
      client = await prisma.client.create({
        data: { clientId: newClientId, userId: resolvedUserId, status: 'CONNECTED' },
      });
    } else {
      await prisma.client.update({
        where: { id: client.id },
        data: { clientId: newClientId, status: 'CONNECTED', userId: resolvedUserId, connectedAt: new Date() },
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

    // Terminate any existing active sessions for this client
    const existingSessions = await prisma.session.findMany({
      where: { clientId: client.id, status: 'ACTIVE' },
      include: { board: true },
    });
    for (const s of existingSessions) {
      await prisma.session.update({
        where: { id: s.id },
        data: { status: 'TERMINATED' },
      });
      sendToBoard(s.board.uniqueId, {
        type: 'CONTROL',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        action: 'DISCONNECT',
        reason: 'client_reconnect',
      });
    }

    // Send user info back to client
    ws.send(JSON.stringify({
      type: 'AUTH_INFO',
      version: MESSAGE_VERSION,
      timestamp: Date.now(),
      userId: resolvedUserId,
      clientId: newClientId,
    }));

    // Free orphaned BUSY boards whose client WS is gone
    const busyBoards = await prisma.board.findMany({
      where: { status: 'BUSY' },
      include: { sessions: { where: { status: 'ACTIVE' }, include: { client: true } } },
    });
    for (const bb of busyBoards) {
      if (bb.sessions.length === 0) {
        await prisma.board.update({ where: { id: bb.id }, data: { status: 'IDLE' } });
      }
      for (const ss of bb.sessions) {
        const cws = clientConnections.get(ss.client.clientId);
        if (!cws || cws.readyState !== WebSocket.OPEN) {
          await prisma.session.update({ where: { id: ss.id }, data: { status: 'TERMINATED' } });
          sendToBoard(bb.uniqueId, {
            type: 'CONTROL', version: MESSAGE_VERSION, timestamp: Date.now(),
            action: 'DISCONNECT', reason: 'client_disconnected',
          });
          await prisma.board.update({ where: { id: bb.id }, data: { status: 'IDLE' } });
        }
      }
    }

    const idleBoards = await prisma.board.findMany({ where: { status: 'IDLE' } });
    const activeBoards = idleBoards.filter(b => {
      const w = boardConnections.get(b.uniqueId);
      return w && w.readyState === WebSocket.OPEN;
    });

    if (activeBoards.length === 0) {
      // Mark orphaned IDLE boards as DISCONNECTED so they don't linger
      if (idleBoards.length > 0) {
        await prisma.board.updateMany({
        where: { id: { in: idleBoards.map((b: any) => b.id) } },
          data: { status: 'OFFLINE' },
        });
      }
      ws.send(JSON.stringify({
        type: 'ERROR',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        code: 'BOARD_NOT_FOUND',
        message: 'No idle boards available',
      }));
      return;
    }

    const board = activeBoards[0];
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
      productConnected: board.productConnected,
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
    const sessions = await prisma.session.findMany({
      where: { board: { uniqueId: id }, status: 'ACTIVE' },
      include: { client: true },
    });
    for (const session of sessions) {
      await prisma.session.update({
        where: { id: session.id },
        data: { status: 'TERMINATED' },
      });
      const clientWs = clientConnections.get(session.client.clientId);
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'END_SESSION',
          version: MESSAGE_VERSION,
          timestamp: Date.now(),
          sessionId: session.id,
          reason: 'board_timeout',
        }));
      }
    }
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
        type: 'END_SESSION',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        sessionId: session.id,
        reason: 'session_expired',
      }));
    }
  }
}

start().catch(console.error);
