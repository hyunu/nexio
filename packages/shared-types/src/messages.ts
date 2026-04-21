export const MESSAGE_VERSION = '1.0';

export type MessageType =
  | 'REGISTER'
  | 'ASSIGN_ID'
  | 'HEARTBEAT'
  | 'DATA_RELAY'
  | 'REQUEST_BOARD'
  | 'BOARD_READY'
  | 'CONTROL'
  | 'AVAILABLE_BOARDS'
  | 'ERROR';

export type BoardStatus = 'IDLE' | 'BUSY' | 'OFFLINE';
export type ClientStatus = 'CONNECTED' | 'DISCONNECTED';
export type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'TERMINATED';
export type DataDirection = 'B_TO_C' | 'C_TO_B';
export type ControlAction = 'RESET' | 'DISCONNECT' | 'PING';

export interface BaseMessage {
  type: MessageType;
  version: string;
  timestamp: number;
}

export interface RegisterMessage extends BaseMessage {
  type: 'REGISTER';
  boardId: string;
  firmwareVersion: string;
  displayAvailable: boolean;
}

export interface AssignIdMessage extends BaseMessage {
  type: 'ASSIGN_ID';
  uniqueId: string;
  serverTime: number;
}

export interface HeartbeatMessage extends BaseMessage {
  type: 'HEARTBEAT';
  id: string;
}

export interface DataRelayMessage extends BaseMessage {
  type: 'DATA_RELAY';
  sessionId: string;
  sourceId: string;
  direction: DataDirection;
  payload: string;
}

export interface RequestBoardMessage extends BaseMessage {
  type: 'REQUEST_BOARD';
  clientId: string;
  sessionDuration: number;
}

export interface BoardReadyMessage extends BaseMessage {
  type: 'BOARD_READY';
  boardId: string;
  sessionId: string;
  assignedAt: number;
  expiresAt: number;
}

export interface ControlMessage extends BaseMessage {
  type: 'CONTROL';
  targetId: string;
  action: ControlAction;
  reason?: string;
}

export interface BoardInfo {
  uniqueId: string;
  status: BoardStatus;
  connectedAt: number;
}

export interface AvailableBoardsMessage extends BaseMessage {
  type: 'AVAILABLE_BOARDS';
  boards: BoardInfo[];
}

export interface ErrorMessage extends BaseMessage {
  type: 'ERROR';
  code: string;
  message: string;
}

export type ClientMessage =
  | RegisterMessage
  | HeartbeatMessage
  | DataRelayMessage
  | RequestBoardMessage
  | ControlMessage;

export type ServerMessage =
  | AssignIdMessage
  | HeartbeatMessage
  | DataRelayMessage
  | BoardReadyMessage
  | ControlMessage
  | AvailableBoardsMessage
  | ErrorMessage;

export type WebSocketMessage = ClientMessage | ServerMessage;

export function isClientMessage(msg: WebSocketMessage): msg is ClientMessage {
  return (
    msg.type === 'REGISTER' ||
    msg.type === 'HEARTBEAT' ||
    msg.type === 'DATA_RELAY' ||
    msg.type === 'REQUEST_BOARD' ||
    msg.type === 'CONTROL'
  );
}

export function isServerMessage(msg: WebSocketMessage): msg is ServerMessage {
  return (
    msg.type === 'ASSIGN_ID' ||
    msg.type === 'HEARTBEAT' ||
    msg.type === 'DATA_RELAY' ||
    msg.type === 'BOARD_READY' ||
    msg.type === 'CONTROL' ||
    msg.type === 'AVAILABLE_BOARDS' ||
    msg.type === 'ERROR'
  );
}
