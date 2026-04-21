# ESP32-C3 Firmware Design

## Overview

ESP32-C3 firmware for QSZNTEC 1.28" round display board. Handles BLE onboarding, Wi-Fi connection, WebSocket communication, and UART data relay.

## System Diagram

```mermaid
graph TB
    subgraph ESP32
        BLE[BLE GATT Server]
        WIFI[Wi-Fi Manager]
        WS[WebSocket Client]
        UART[UART Handler]
        DIS[TFT Display]
        NVS[NVS Storage]
    end

    PHONE[Phone App] -->|BLE| BLE
    WIFI -->|Wi-Fi| AP[Wi-Fi AP]
    WS -->|WSS| SERVER[Server]
    UART -->|UART| PRODUCT[Product P]
```

## State Machine

```mermaid
stateDiagram-v2
    [*] --> BOOT
    BOOT --> BLE_WAIT: No Wi-Fi Config
    BOOT --> WIFI_CONNECT: Config Exists
    BLE_WAIT --> WIFI_CONNECT: BLE Config Received
    WIFI_CONNECT --> WS_CONNECT: Wi-Fi Connected
    WS_CONNECT --> REGISTER: WebSocket Connected
    REGISTER --> IDLE: ASSIGN_ID Received
    IDLE --> RELAY: DATA_RELAY Received
    RELAY --> IDLE
    IDLE --> ERROR: Disconnected
    ERROR --> WIFI_RECONNECT: Reconnect Wi-Fi
```

## Data Flow

```mermaid
sequenceDiagram
    participant Phone
    participant BLE
    participant NVS
    participant WIFI
    participant WS
    participant UART

    Phone->>BLE: BLE Write (SSID/Pass/URL)
    BLE->>NVS: Save Config
    NVS-->>WIFI: Load Config
    WIFI->>AP: Connect Wi-Fi
    AP-->>WIFI: Connected
    WIFI->>WS: Connect WebSocket
    WS->>SERVER: REGISTER
    SERVER-->>WS: ASSIGN_ID
    WS->>DIS: Display ID

    Note over UART,WS: Data Relay
    UART->>WS: UART Data
    WS->>SERVER: DATA_RELAY (Base64)
    SERVER-->>WS: DATA_RELAY
    WS->>UART: Decode & Output
```

## Module Design

### BLE Module (`ble.cpp`)

```
┌─────────────────────────────────────────┐
│           BLE GATT Server               │
├─────────────────────────────────────────┤
│ Service UUID: 6e400001-...              │
│                                         │
│ TX (Notify): 6e400002-...  ──► Phone   │
│ RX (Write):  6e400003-...  ◄── Phone  │
└─────────────────────────────────────────┘
```

**Characteristic RX receives JSON:**
```json
{
  "ssid": "MyWiFi",
  "password": "password123",
  "serverUrl": "ws://192.168.1.100:10008/ws/board"
}
```

### Wi-Fi Module (`wifi.cpp`)

- Stores SSID, Password, Server URL in NVS
- Auto-connect on boot
- Reconnect on disconnect

### WebSocket Module (`websocket.cpp`)

- SSL/TLS connection to server
- Auto-reconnect with 5s interval
- Heartbeat every 30s

### UART Module (`uart.cpp`)

- Baud rate: 115200 (configurable)
- Data: Binary (passthrough)
- Encoding: Base64 for JSON payload

### Display Module (`display.cpp`)

```
┌────────────────────┐
│     Nexio          │
│ WiFi: Connected    │
│ SSID: MyNetwork   │
│ WS: Connected     │
│ ID: BOARD-0001    │
└────────────────────┘
```

## Pin Configuration

| Pin | Function | Notes |
|-----|----------|-------|
| 7 | UART TX | Product RX |
| 6 | UART TX | Product TX |
| 10 | TFT CS | Display |
| 2 | TFT DC | Display |
| 3 | TFT RST | Display |

## Message Protocol

### Outgoing: REGISTER
```json
{
  "type": "REGISTER",
  "version": "1.0",
  "timestamp": 1700000000000,
  "boardId": "AA:BB:CC:DD:EE:FF",
  "firmwareVersion": "1.0.0",
  "displayAvailable": true
}
```

### Incoming: ASSIGN_ID
```json
{
  "type": "ASSIGN_ID",
  "version": "1.0",
  "timestamp": 1700000000000,
  "uniqueId": "BOARD-0001",
  "serverTime": 1700000000000
}
```

### DATA_RELAY (P → C)
```json
{
  "type": "DATA_RELAY",
  "version": "1.0",
  "timestamp": 1700000000000,
  "sessionId": "SESSION-ABC123",
  "sourceId": "BOARD-0001",
  "direction": "B_TO_C",
  "payload": "base64encodedBinaryData=="
}
```

## Required Libraries

| Library | Version | Purpose |
|---------|---------|---------|
| ArduinoWebsockets | Latest | WebSocket client |
| ArduinoJson | 6.x | JSON parsing |
| NimBLE-Arduino | Latest | BLE GATT server |
| TFT_eSPI | Latest | Display control |

## Error Handling

```mermaid
graph TD
    E1[Wi-Fi Disconnect] --> R1[Retry 3s]
    R1 --> WiFi

    E2[WS Disconnect] --> R2[Retry 5s]
    R2 --> WS

    E3[CONTROL RESET] --> R3[ESP.restart]
```
