import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { PrismaClient } from '@prisma/client';
import { WEBSOCKET_PATHS, MESSAGE_VERSION, HEARTBEAT_TIMEOUT_MS } from '@nexio/shared-types';

const fastify = Fastify({ logger: true });
const prisma = new PrismaClient();

const PORT = parseInt(process.env.PORT || '10008');

const boardConnections = new Map<string, WebSocket>();
const clientConnections = new Map<string, WebSocket>();
const heartbeatTimers = new Map<string, NodeJS.Timeout>();

async function start() {
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

  fastify.get('/api/clients', async () => {
    const clients = await prisma.client.findMany({
      orderBy: { connectedAt: 'desc' },
    });
    return clients;
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

  const server = createServer(fastify.server);

  const wss = new WebSocketServer({ server, path: WEBSOCKET_PATHS.BOARD });

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

  const clientWss = new WebSocketServer({ server, path: WEBSOCKET_PATHS.CLIENT });

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

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });

  setInterval(checkExpiredSessions, 60000);
}

async function handleBoardMessage(ws: WebSocket, msg: any, setBoardId: (id: string) => void) {
  const { type, boardId, firmwareVersion, displayAvailable, sessionId, payload, direction, id } = msg;

  if (type === 'REGISTER') {
    const existingBoard = await prisma.board.findUnique({
      where: { macAddress: boardId },
    });

    let uniqueId: string;
    if (existingBoard) {
      uniqueId = existingBoard.uniqueId;
      await prisma.board.update({
        where: { id: existingBoard.id },
        data: { status: 'IDLE', connectedAt: new Date(), wsConnection: 'active' },
      });
    } else {
      const count = await prisma.board.count();
      uniqueId = `BOARD-${String(count + 1).padStart(4, '0')}`;
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
  const { type, clientId, sessionDuration, sessionId, payload, direction, id } = msg;

  if (type === 'REQUEST_BOARD') {
    const newClientId = clientId || `CLIENT-${Date.now()}`;

    let client = await prisma.client.findUnique({ where: { clientId: newClientId } });
    if (!client) {
      client = await prisma.client.create({
        data: { clientId: newClientId, status: 'CONNECTED' },
      });
    } else {
      await prisma.client.update({
        where: { id: client.id },
        data: { status: 'CONNECTED', connectedAt: new Date() },
      });
    }

    setClientId(newClientId);
    clientConnections.set(newClientId, ws);

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
