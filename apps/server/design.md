# Server Design

## Overview

Node.js server with Fastify for HTTP API and WebSocket for real-time communication. Handles board registration, session management, and data relay.

## Architecture

```mermaid
graph TB
    subgraph "External Clients"
        BOARD[ESP32 Board<br/>/ws/board]
        CLIENT[Client App<br/>/ws/client]
        WEB[Web Dashboard<br/>/api/*]
    end

    subgraph "Server"
        HTTP[Fastify HTTP<br/>:10008]
        WS[WebSocket Server<br/>:10008]
        API[API Routes]
        WS_B[Board Handler]
        WS_C[Client Handler]
    end

    subgraph "Services"
        HS[Heartbeat Service]
        SS[Session Service]
        BS[Board Service]
    end

    subgraph "Database"
        DB[(MySQL<br/>Prisma)]
    end

    HTTP --> API
    API --> DB
    WS --> WS_B
    WS --> WS_C
    WS_B --> DB
    WS_C --> DB
    HS --> DB
    SS --> DB
```

## WebSocket Endpoints

```
/ws/board    - ESP32 boards connect here
/ws/client   - Client apps connect here
```

## Database Schema

```mermaid
erDiagram
    BOARD ||--o{ SESSION : has
    CLIENT ||--o{ SESSION : has

    BOARD {
        string id PK
        string uniqueId UK
        string macAddress
        string status
        string firmwareVersion
        bool displayAvailable
        datetime connectedAt
        datetime updatedAt
    }

    CLIENT {
        string id PK
        string clientId UK
        string status
        datetime connectedAt
        datetime updatedAt
    }

    SESSION {
        string id PK
        string boardId FK
        string clientId FK
        datetime assignedAt
        datetime expiresAt
        string status
    }
```

## Board Connection Flow

```mermaid
sequenceDiagram
    participant B as Board
    participant WS as WebSocket
    participant DB as Database

    B->>WS: CONNECT /ws/board
    B->>WS: REGISTER (boardId, firmwareVersion)
    WS->>DB: Check/Create Board
    DB-->>WS: Board record
    WS->>WS: Generate uniqueId (BOARD-0001)
    WS->>DB: Save Board (IDLE)
    WS->>B: ASSIGN_ID (uniqueId)
    WS->>WS: Start Heartbeat Timer

    loop Heartbeat
        B->>WS: HEARTBEAT
        WS->>WS: Reset Timer
        WS->>B: HEARTBEAT (pong)
    end
```

## Client Connection Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant WS as WebSocket
    participant DB as Database

    C->>WS: CONNECT /ws/client
    C->>WS: REQUEST_BOARD (clientId, duration)
    WS->>DB: Find IDLE board
    DB-->>WS: Board list

    alt Board Available
        WS->>DB: Create Session
        WS->>DB: Update Board (BUSY)
        WS->>C: BOARD_READY (boardId, sessionId)
        WS->>B: BOARD_READY (via board connection)
    else No Board
        WS->>C: ERROR (BOARD_NOT_FOUND)
    end
```

## Data Relay Flow

```mermaid
sequenceDiagram
    participant P as Product
    participant B as Board
    participant S as Server
    participant C as Client

    P->>B: UART Binary
    B->>B: Base64 Encode
    B->>S: DATA_RELAY (B_TO_C, payload)
    S->>S: Find Session by board
    S->>C: DATA_RELAY (B_TO_C, payload)
    C->>C: Base64 Decode

    C->>S: DATA_RELAY (C_TO_B, payload)
    S->>S: Find Session by client
    S->>B: DATA_RELAY (C_TO_B, payload)
    B->>B: Base64 Decode
    B->>P: UART Binary
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/boards` | List all boards |
| GET | `/api/boards/idle` | List idle boards |
| GET | `/api/clients` | List all clients |
| POST | `/api/sessions` | Create session |
| DELETE | `/api/sessions/:id` | Delete session |
| POST | `/api/control` | Send control command |

## Message Types

### Board → Server

```json
{
  "type": "REGISTER",
  "boardId": "AA:BB:CC:DD:EE:FF",
  "firmwareVersion": "1.0.0",
  "displayAvailable": true
}
```

```json
{
  "type": "HEARTBEAT",
  "id": "BOARD-0001"
}
```

```json
{
  "type": "DATA_RELAY",
  "sessionId": "session-uuid",
  "direction": "B_TO_C",
  "payload": "base64..."
}
```

### Server → Board

```json
{
  "type": "ASSIGN_ID",
  "uniqueId": "BOARD-0001",
  "serverTime": 1700000000000
}
```

```json
{
  "type": "BOARD_READY",
  "sessionId": "session-uuid",
  "expiresAt": 1700003600000
}
```

```json
{
  "type": "CONTROL",
  "action": "RESET"
}
```

## Heartbeat & Timeout

```mermaid
stateDiagram-v2
    [*] --> CONNECTED
    CONNECTED --> HEARTBEAT_OK: Heartbeat received
    HEARTBEAT_OK --> HEARTBEAT_OK: Heartbeat received
    HEARTBEAT_OK --> TIMEOUT: 60s no heartbeat
    TIMEOUT --> OFFLINE: Close connection
```

- Heartbeat interval: 30s
- Timeout: 60s (disconnect if no heartbeat for 60s)

## Session Management

```mermaid
graph TD
    E[Session Expires] --> T{Time Check}
    T -->|Expired| S1[Update Session (EXPIRED)]
    T -->|Active| S2[Keep Active]
    S1 --> S3[Update Board (IDLE)]
    S3 --> S4[Notify Board]
    S4 --> S5[Notify Client]
```
