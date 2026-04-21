# Client App Design

## Overview

Electron desktop application that connects to the server via WebSocket and bridges data to/from a local serial port.

## Architecture

```mermaid
graph TB
    subgraph "Client App"
        UI[React UI]
        IPC[IPC Bridge]
        WS[WebSocket Client]
        SER[Serial Port]
    end

    subgraph "External"
        SERVER[Server<br/>ws://host:10008/ws/client]
        DEVICE[Serial Device]
    end

    UI --> IPC
    IPC --> WS
    IPC --> SER
    WS <--> SERVER
    SER <--> DEVICE
```

## Data Flow

```mermaid
sequenceDiagram
    participant User
    participant UI as React UI
    participant WS as WebSocket
    participant SER as Serial Port
    participant S as Server
    participant B as Board

    User->>UI: Enter Server URL
    UI->>WS: Connect WebSocket
    WS->>S: CONNECT /ws/client
    S-->>WS: Connected
    WS->>UI: Connected

    User->>UI: Select Serial Port
    UI->>SER: Open Serial
    SER-->>UI: Port Opened
    UI->>S: REQUEST_BOARD
    S-->>S: Assign Session
    S-->>UI: BOARD_READY

    Note over SER,S: P → C Direction
    SER->>SER: Read Serial Data
    SER->>UI: Data Event
    UI->>UI: Base64 Encode
    UI->>S: DATA_RELAY (C_TO_B)

    Note over B,SER: C → P Direction
    S-->>UI: DATA_RELAY (B_TO_C)
    UI->>UI: Base64 Decode
    UI->>SER: Write Serial
    SER->>DEVICE: UART Output
```

## UI Layout

```
┌─────────────────────────────────────────┐
│           Nexio Client                  │
├─────────────────────────────────────────┤
│ ┌─ Server Connection ──────────────────┐ │
│ │ URL: [ws://localhost:10008/ws/client]│ │
│ │ [Connect] ● Connected              │ │
│ └───────────────────────────────────┘ │
│                                         │
│ ┌─ Serial Port ───────────────────────┐ │
│ │ Port: [COM3 ▼] Baud: [115200 ▼]     │ │
│ │ [Open Port] ● Port Open            │ │
│ └───────────────────────────────────┘ │
│                                         │
│ ┌─ Board Status ──────────────────────┐ │
│ │ Board: BOARD-0001                    │ │
│ │ Expires: 2024-01-01 12:00:00       │ │
│ └───────────────────────────────────┘ │
│                                         │
│ ┌─ Data Log ─────────────────────────┐ │
│ │ [12:00:00] TX: Hello World         │ │
│ │ [12:00:01] RX: Response data       │ │
│ └───────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

## Key Features

### 1. Server Connection

- WebSocket client to server
- Auto-reconnect with exponential backoff
- Connection status indicator

### 2. Serial Port Management

- List available COM ports
- Select baud rate: 9600 - 921600
- Open/close port
- Read/write binary data

### 3. Board Request

- Request board from server
- Receive BOARD_READY
- Display assigned board ID
- Show session expiry time

### 4. Data Relay

- Serial → Server: Encode binary as Base64
- Server → Serial: Decode Base64 to binary

### 5. Data Log

- Real-time log of sent/received data
- Display mode: Text or Hex
- Clear log

## Message Protocol

### REQUEST_BOARD
```json
{
  "type": "REQUEST_BOARD",
  "version": "1.0",
  "timestamp": 1700000000000,
  "clientId": "CLIENT-123",
  "sessionDuration": 3600
}
```

### DATA_RELAY (C → B)
```json
{
  "type": "DATA_RELAY",
  "version": "1.0",
  "timestamp": 1700000000000,
  "sessionId": "session-uuid",
  "sourceId": "CLIENT-123",
  "direction": "C_TO_B",
  "payload": "base64encodedData=="
}
```

### Incoming: BOARD_READY
```json
{
  "type": "BOARD_READY",
  "version": "1.0",
  "timestamp": 1700000000000,
  "boardId": "BOARD-0001",
  "sessionId": "session-uuid",
  "assignedAt": 1700000000000,
  "expiresAt": 1700003600000
}
```

### Incoming: DATA_RELAY
```json
{
  "type": "DATA_RELAY",
  "version": "1.0",
  "timestamp": 1700000000000,
  "sessionId": "session-uuid",
  "sourceId": "BOARD-0001",
  "direction": "B_TO_C",
  "payload": "base64encodedData=="
}
```

## State Machine

```mermaid
stateDiagram-v2
    [*] --> DISCONNECTED
    DISCONNECTED --> CONNECTING: Connect Server
    CONNECTING --> CONNECTED: Connected
    CONNECTED --> REQUESTING: Request Board
    REQUESTING --> READY: BOARD_READY
    READY --> RELAY: Data Available
    RELAY --> READY

    DISCONNECTED --> PORT_CLOSED: Open Serial
    PORT_CLOSED --> PORT_OPEN: Port Opened
    PORT_OPEN --> PORT_CLOSED: Close Serial
```

## Error Handling

| Error | Action |
|-------|--------|
| WebSocket disconnect | Auto-reconnect (1s→2s→4s→max 30s) |
| Serial port error | Show error message |
| Session expired | Notify user, request new board |
| Server error | Log and display message |