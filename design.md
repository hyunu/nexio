# Nexio - ESP32 Wireless UART Bridge System

## System Architecture Overview

```mermaid
graph TB
    P[Product P<br/>UART Device] -->|UART Binary| B[ESP32-C3 Board]
    B -->|Wi-Fi| S[Server S]
    S -->|WebSocket| C[Client App]
    S -->|WebSocket| F[Web Dashboard]

    subgraph Mobile
    A[Phone App<br/>BLE Onboarding]
    end
    A -->|BLE| B

    subgraph Server
    BS[WebSocket Server<br/>BS]
    FS[Web Dashboard<br/>FS]
    DB[(MySQL)]
    end
    BS --> DB
    FS --> BS
```

## Data Flow

```mermaid
sequenceDiagram
    participant P as Product (UART)
    participant B as ESP32 Board
    participant S as Server
    participant C as Client

    Note over P,C: P → C Direction
    P->>B: UART Binary Data
    B->>B: Base64 Encode
    B->>S: DATA_RELAY (JSON+Base64)
    S->>C: DATA_RELAY (JSON+Base64)
    C->>C: Base64 Decode

    Note over C,P: C → P Direction
    C->>C: Base64 Encode
    C->>S: DATA_RELAY (JSON+Base64)
    S->>B: DATA_RELAY (JSON+Base64)
    B->>B: Base64 Decode
    B->>P: UART Binary Data
```

## System Components

| Component | Identifier | Description |
|------------|------------|-------------|
| Product | P | UART device that sends/receives binary data |
| ESP32 Board | B | QSZNTEC ESP32-C3 with 1.28" round display |
| Server | S | Relay server (BS + FS) |
| Client App | C | Desktop/Web application |
| Phone App | A | BLE-based ESP32 onboarding mobile app |

## Technology Stack

```mermaid
graph LR
    subgraph Firmware
        F1[Arduino IDE]
        F2[ESP32-C3]
        F3[NimBLE-Arduino]
        F4[TFT_eSPI]
    end

    subgraph Server
        S1[Node.js]
        S2[Fastify]
        S3[WebSocket]
        S4[Prisma]
        S5[MySQL]
    end

    subgraph Client
        C1[Electron]
        C2[React]
        C3[SerialPort]
    end

    subgraph Mobile
        M1[Flutter]
        M2[flutter_blue_plus]
    end
```

## Communication Protocol

### Message Format

All messages follow this structure:

```json
{
  "type": "MESSAGE_TYPE",
  "version": "1.0",
  "timestamp": 1700000000000
}
```

### Board ↔ Server Flow

```mermaid
stateDiagram-v2
    [*] --> OFFLINE
    OFFLINE --> ONLINE: Wi-Fi Connected
    ONLINE --> IDLE: ASSIGN_ID Received
    IDLE --> BUSY: Session Assigned
    BUSY --> IDLE: Session Expired/Terminated
    BUSY --> OFFLINE: Disconnected
    IDLE --> OFFLINE: Disconnected
```

## Project Structure

```
nexio/
├── docker-compose.yml              # Root: MySQL + Server
├── firmware/                       # ESP32-C3 Arduino
├── apps/
│   ├── server/                    # Node.js + Fastify + WebSocket
│   ├── client/                     # Electron Desktop App
│   ├── web/                        # React Dashboard
│   └── mobile/                     # Flutter BLE App
└── packages/
    └── shared-types/               # TypeScript Message Types
```

## Security

- WebSocket: WSS (TLS) in production, WS allowed in development
- Board identification: MAC address based, server issues uniqueId
- Client authentication: Optional (JWT can be added later)

## Real-time Requirements

- DATA_RELAY: Forward immediately (no buffering)
- WebSocket latency target: < 50ms (local network)
