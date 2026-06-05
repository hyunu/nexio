import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { PrismaClient } from '@prisma/client';
import { WEBSOCKET_PATHS, MESSAGE_VERSION, HEARTBEAT_TIMEOUT_MS } from '@nexio/shared-types';

const PORT = parseInt(process.env.PORT || '10008');

const boardConnections = new Map<string, WebSocket>();
const clientConnections = new Map<string, WebSocket>();
const heartbeatTimers = new Map<string, NodeJS.Timeout>();

const prisma = new PrismaClient();

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
    if (board) {
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

  fastify.post('/api/onboarding/claim', async (request: any) => {
    const { macAddress } = request.body;
    if (!macAddress) {
      return { error: 'MAC address is required' }, 400;
    }

    const existingBoard = await prisma.board.findFirst({
      where: { macAddress },
    });
    if (existingBoard && existingBoard.uniqueId) {
      return { uniqueId: existingBoard.uniqueId };
    }

    const count = await prisma.board.count();
    const uniqueId = `${String(count + 1).padStart(4, '0')}`;

    await prisma.board.create({
      data: {
        uniqueId,
        macAddress,
        status: 'CLAIMED',
      },
    });

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

    if (boardWs && boardWs.readyState === WebSocket.OPEN) {
      boardWs.send(JSON.stringify({
        type: 'BOARD_READY',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        boardId: board.uniqueId,
        sessionId: session.id,
        assignedAt: now.getTime(),
        expiresAt: expiresAt.getTime(),
      }));
    }

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
      const boardWs = boardConnections.get(board.uniqueId);
      if (boardWs && boardWs.readyState === WebSocket.OPEN) {
        boardWs.send(JSON.stringify({
          type: 'CONTROL',
          version: MESSAGE_VERSION,
          timestamp: Date.now(),
          targetId: board.uniqueId,
          action: 'DISCONNECT',
          reason: 'session_terminated',
        }));
      }
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

    const boardWs = boardConnections.get(id);
    if (boardWs && boardWs.readyState === WebSocket.OPEN) {
      boardWs.send(JSON.stringify({
        type: 'CONTROL',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        targetId: id,
        action: 'FACTORY_RESET',
        reason: 'board_discarded',
      }));
      boardConnections.delete(id);
    }

    return { success: true, discarded: true };
  });

  fastify.post('/api/control', async (request: any) => {
    const { targetId, action, type } = request.body;

    if (type === 'board') {
      const board = await prisma.board.findUnique({ where: { uniqueId: targetId } });
      if (board) {
        const ws = boardConnections.get(targetId);
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

  const wss = new WebSocketServer({ server: fastify.server, path: WEBSOCKET_PATHS.BOARD });

  wss.on('connection', (ws, req) => {
    let boardId: string | null = null;

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await handleBoardMessage(ws, msg, (id) => { boardId = id; });
      } catch (err) {
        console.error('Board message error:', err);
      }
    });

    ws.on('close', async () => {
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

  const clientWss = new WebSocketServer({ server: fastify.server, path: WEBSOCKET_PATHS.CLIENT });

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

  await fastify.listen({ port: PORT, host: '0.0.0.0' });

  setInterval(checkExpiredSessions, 60000);
}

async function handleBoardMessage(ws: WebSocket, msg: any, setBoardId: (id: string) => void) {
  const { type, boardId, firmwareVersion, displayAvailable, sessionId, payload, direction, id, uniqueId: preAssignedId } = msg;

  if (type === 'REGISTER') {
    let uniqueId: string;

    if (preAssignedId) {
      const claimed = await prisma.board.findUnique({
        where: { uniqueId: preAssignedId },
      });
      if (claimed) {
        if (claimed.status === 'DISCARDED') {
          ws.send(JSON.stringify({
            type: 'CONTROL',
            version: MESSAGE_VERSION,
            timestamp: Date.now(),
            targetId: claimed.uniqueId,
            action: 'FACTORY_RESET',
            reason: 'board_discarded',
          }));
          ws.close();
          return;
        }
        uniqueId = claimed.uniqueId;
        await prisma.board.update({
          where: { id: claimed.id },
          data: {
            macAddress: boardId,
            firmwareVersion,
            displayAvailable,
            status: 'IDLE',
            connectedAt: new Date(),
          },
        });
      } else {
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
          ws.send(JSON.stringify({
            type: 'CONTROL',
            version: MESSAGE_VERSION,
            timestamp: Date.now(),
            targetId: existingBoard.uniqueId,
            action: 'FACTORY_RESET',
            reason: 'board_discarded',
          }));
          ws.close();
          return;
        }
        uniqueId = existingBoard.uniqueId;
        await prisma.board.update({
          where: { id: existingBoard.id },
          data: { status: 'IDLE', connectedAt: new Date() },
        });
      } else {
        const count = await prisma.board.count();
        uniqueId = `${String(count + 1).padStart(4, '0')}`;
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
        }
      }
    }
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
    if (boardWs && boardWs.readyState === WebSocket.OPEN) {
      boardWs.send(JSON.stringify({
        type: 'BOARD_READY',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        boardId: board.uniqueId,
        sessionId: session.id,
        assignedAt: now.getTime(),
        expiresAt: expiresAt.getTime(),
      }));
    }

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
        const boardWs = boardConnections.get(board.uniqueId);
        if (boardWs && boardWs.readyState === WebSocket.OPEN) {
          boardWs.send(JSON.stringify({
            type: 'DATA_RELAY',
            version: MESSAGE_VERSION,
            timestamp: Date.now(),
            sessionId,
            sourceId: clientId || id,
            direction,
            payload,
          }));
        }
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

    const boardWs = boardConnections.get(session.board.uniqueId);
    if (boardWs && boardWs.readyState === WebSocket.OPEN) {
      boardWs.send(JSON.stringify({
        type: 'CONTROL',
        version: MESSAGE_VERSION,
        timestamp: Date.now(),
        targetId: session.board.uniqueId,
        action: 'DISCONNECT',
        reason: 'session_expired',
      }));
    }

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
