# Web Dashboard Design

## Overview

React-based web dashboard for monitoring and managing boards, clients, and sessions in real-time.

## Architecture

```mermaid
graph TB
    subgraph "Web Dashboard"
        UI[React SPA]
        API[REST API Client]
        WS[WebSocket Client]
    end

    subgraph "Server"
        HTTP[Fastify HTTP]
        WS_S[WebSocket Server]
    end

    UI --> HTTP
    UI --> WS_S

    HTTP <--> DB[(MySQL)]
```

## Dashboard Layout

```
┌──────────────────────────────────────────────────────┐
│  Nexio Dashboard                              [🔄]  │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌────────────────────┐  ┌────────────────────┐     │
│  │ Boards (3)         │  │ Clients (2)        │     │
│  │                    │  │                    │     │
│  │ 🔵 BOARD-0001 IDLE │  │ ● CLIENT-1 CONNECTED│    │
│  │ 🟢 BOARD-0002 BUSY  │  │ ● CLIENT-2 CONNECTED│    │
│  │ 🔴 BOARD-0003 OFF   │  │                    │     │
│  └────────────────────┘  └────────────────────┘     │
│                                                      │
│  ┌─ Create Session ───────────────────────────────┐ │
│  │ Board: [BOARD-0001 ▼]                          │ │
│  │ Client: [CLIENT-1 ▼]                           │ │
│  │ [Connect]                                      │ │
│  └───────────────────────────────────────────────┘ │
│                                                      │
└──────────────────────────────────────────────────────┘
```

## Board List Component

```
┌────────────────────────────────────────┐
│ Boards (3)                     [+ Add]│
├────────────────────────────────────────┤
│ Unique ID    │ Status │ Connected    │
├────────────────────────────────────────┤
│ BOARD-0001   │ IDLE   │ 12:00:00     │
│ BOARD-0002   │ BUSY   │ 11:30:00     │
│ BOARD-0003   │ OFFLINE│ 10:15:00     │
└────────────────────────────────────────┘
         [Reset] [Disconnect]
```

## Client List Component

```
┌────────────────────────────────────────┐
│ Clients (2)                     [+ Add]│
├────────────────────────────────────────┤
│ Client ID     │ Status    │ Connected │
├────────────────────────────────────────┤
│ CLIENT-1      │ CONNECTED │ 12:00:00  │
│ CLIENT-2      │ CONNECTED │ 11:45:00  │
└────────────────────────────────────────┘
         [Ping] [Disconnect]
```

## Session Management

```mermaid
sequenceDiagram
    participant User
    participant Dashboard
    participant API
    participant Server
    participant Board
    participant Client

    User->>Dashboard: Select Board & Client
    Dashboard->>API: POST /api/sessions
    API->>Server: Create session
    Server->>Server: Validate board is IDLE

    alt Success
        Server->>DB: Create session record
        Server->>Board: BOARD_READY
        Server->>Client: BOARD_READY
        Server-->>Dashboard: Session created
        Dashboard->>User: Show success
    else No idle board
        Server-->>Dashboard: Error
        Dashboard->>User: Show error
    end
```

## Control Actions

```mermaid
graph TD
    A[Control Action] --> B{Action Type}
    B -->|RESET| C[Send to Board]
    B -->|DISCONNECT| D[Send to Target]
    B -->|PING| E[Send Ping]

    C --> C1[Board: ESP.restart]
    D --> D1[Close Connection]
    E --> E1[Return PONG]
```

## API Integration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/boards` | Get all boards |
| GET | `/api/boards/idle` | Get idle boards |
| GET | `/api/clients` | Get all clients |
| POST | `/api/sessions` | Create session |
| DELETE | `/api/sessions/:id` | Delete session |
| POST | `/api/control` | Send control |

## Real-time Updates

- Auto-refresh every 5 seconds
- WebSocket connection for live updates (optional)
- Visual status indicators with colors

## Status Colors

| Status | Color | Meaning |
|--------|-------|---------|
| IDLE | 🟢 Green | Board ready for use |
| BUSY | 🟡 Yellow | Board in use |
| OFFLINE | 🔴 Red | Board disconnected |
| CONNECTED | 🟢 Green | Client connected |
| DISCONNECTED | 🔴 Red | Client disconnected |