# Web Dashboard Design

## Overview

React-based web dashboard served by the Fastify server as a static SPA. Monitors and manages boards, clients, and sessions in real-time via REST API + optional WebSocket monitor connection.

## Architecture

The dashboard is built with React and served as static files from `apps/web/dist/`. The Fastify server registers `@fastify/static` at runtime and serves `index.html` as SPA fallback for unknown GET routes.

```
Browser ──GET /──→ Fastify ──→ dist/index.html
         ──GET /api/boards──→ Fastify ──→ MySQL
         ──WS /ws/monitor───→ Fastify ──→ Board/Client events
```

## Dashboard Layout

```
┌────────────────────────────────────────────────────────┐
│  Nexio Dashboard                                [🔄]  │
├────────────────────────────────────────────────────────┤
│                                                        │
│  ┌────────────────────┐  ┌────────────────────┐       │
│  │ Boards (3)         │  │ Clients (2)        │       │
│  │ BOARD-0001 IDLE    │  │ CLIENT-1 CONNECTED │       │
│  │ BOARD-0002 BUSY    │  │ CLIENT-2 CONNECTED │       │
│  │ BOARD-0003 OFFLINE │  │                    │       │
│  └────────────────────┘  └────────────────────┘       │
│                                                        │
│  ┌─ Create Session ─────────────────────────────────┐ │
│  │ Board: [BOARD-0001 ▼]  Client: [CLIENT-1 ▼]     │ │
│  │ [Connect]                                        │ │
│  └─────────────────────────────────────────────────┘ │
│                                                        │
│  ┌─ Sessions ───────────────────────────────────────┐ │
│  │ session-id │ BOARD-0001 │ CLIENT-1 │ ACTIVE      │ │
│  │ session-id │ BOARD-0002 │ CLIENT-2 │ TERMINATED  │ │
│  └─────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

## Features

### Boards List

- Table: Unique ID, MAC Address, Status, Firmware, Display Available, Location, Connected At
- Status badges: IDLE (green), BUSY (yellow), OFFLINE (red), CLAIMED (blue), DISCARDED (gray)
- Actions per board: Reset, Discard (sends CONTROL DISCARD via server → board WS)

### Clients List

- Table: Client ID, Username (linked User), Status, Connected At
- Status badges: CONNECTED (green), DISCONNECTED (red)
- Actions: Disconnect (sends CONTROL DISCONNECT via server → client WS)

### Users List

- Table: Username, Email, Organization, Active toggle, Admin toggle
- Actions: Toggle Active, Toggle Admin
- Admin users have a badge

### Session Management

- Create session: select IDLE board + connected client → POST `/api/sessions`
- Terminate session: POST `/api/sessions/:id/terminate`
- Delete session: DELETE `/api/sessions/:id`

### Real-time Updates

- WebSocket connection to `/ws/monitor` for live board/client status changes
- Periodic auto-refresh fallback

## Status Colors

| Status | Color | Entity |
|--------|-------|--------|
| IDLE | Green | Board ready |
| BUSY | Yellow | Board in use |
| OFFLINE | Red | Board disconnected |
| CLAIMED | Blue | Board claimed (not yet registered) |
| DISCARDED | Gray | Board discarded |
| CONNECTED | Green | Client connected |
| DISCONNECTED | Red | Client disconnected |

## API Integration

All data fetched via REST API from same origin. WS monitor for live updates.

## Key Files

| File | Contents |
|------|----------|
| `src/` | React components: BoardList, ClientList, UserList, Sessions |
| `dist/` (build output) | Served by Fastify server at runtime |
