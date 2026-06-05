# Mobile App Design

## Overview

Flutter mobile application for BLE-based ESP32 onboarding. Scans for Nexio ESP32 devices via BLE and sends WiFi configuration.

## Architecture

```mermaid
graph TB
    subgraph "Mobile App"
        BLE[BLE Scanner]
        UI[Flutter UI]
        STORAGE[SharedPreferences]
    end

    subgraph "ESP32 Board"
        BLE_ESP[BLE GATT Server]
        NVS[NVS Storage]
        WIFI[Wi-Fi Manager]
    end

    UI --> BLE
    BLE <--> BLE_ESP
    BLE_ESP --> NVS
    NVS --> WIFI
```

## Screens

```mermaid
graph TD
    HOME[Home Screen<br/>Scan Devices] --> SELECT[Device Selection]
    SELECT --> CONFIG[Config Screen<br/>Enter WiFi]
    CONFIG --> WAITING[Waiting for Board<br/>Server Polling]
    WAITING -->|Board Registered| SUCCESS[Onboarding Complete]
    WAITING -->|Timeout| FAIL[Onboarding Failed]

    CONFIG -->|Cancel| HOME
    SUCCESS -->|Done| HOME
    FAIL -->|Retry| CONFIG
    FAIL -->|Done| HOME
```

### Screen 1: Home (Device Scan)

```
┌────────────────────────────┐
│ ← Nexio Setup              │
├────────────────────────────┤
│                            │
│ 🔍 Scanning for devices...│
│                            │
│ ┌────────────────────────┐ │
│ │ 🔵 Nexio-ESP32          │
│ │    AA:BB:CC:DD:EE:FF   │ │
│ └────────────────────────┘ │
│                            │
│ Saved Server:              │
│ ws://192.168.1.100:10008    │
│                            │
│    [Refresh]               │
└────────────────────────────┘
```

### Screen 2: Configuration

```
┌────────────────────────────┐
│ ← Configure WiFi          │
├────────────────────────────┤
│                            │
│ Device: Nexio-ESP32        │
│ MAC: AA:BB:CC:DD:EE:FF     │
│                            │
│ ┌────────────────────────┐ │
│ │ WiFi SSID               │ │
│ │ [MyWiFi           ]     │ │
│ └────────────────────────┘ │
│                            │
│ ┌────────────────────────┐ │
│ │ WiFi Password          │ │
│ │ [********         ]    │ │
│ └────────────────────────┘ │
│                            │
│ ┌────────────────────────┐ │
│ │ Server URL             │ │
│ │ [ws://192.168.1.100    │ │
│ │     :10008/ws/board]   │ │
│ └────────────────────────┘ │
│                            │
│ ┌────────────────────────┐ │
│ │ 🔗 Sending...         │ │
│ └────────────────────────┘ │
└────────────────────────────┘
```

### Screen 3: Onboarding Progress

```
┌────────────────────────────┐
│ ← Configure WiFi          │
├────────────────────────────┤
│                            │
│ Device: Nexio-ESP32        │
│ MAC: AA:BB:CC:DD:EE:FF     │
│                            │
│ ┌────────────────────────┐ │
│ │  ◎ Sending...          │ │
│ │  ✓ Configuration sent! │ │
│ │  ◌ Waiting for board   │ │
│ │    to connect server…  │ │
│ └────────────────────────┘ │
│          ○ spinner         │
│                            │
│    (polling server via     │
│     GET /api/boards/       │
│       onboarding?mac=...)   │
│                            │
└────────────────────────────┘
```

### Screen 4: Result

```
┌────────────────────────────┐
│ ← Configure WiFi          │
├────────────────────────────┤
│                            │
│      ✓ Onboarding Done!    │
│                            │
│ Board registered as        │
│    BOARD-0001              │
│                            │
│ ┌────────────────────────┐ │
│ │     Done              │ │
│ └────────────────────────┘ │
└────────────────────────────┘
```

```
┌────────────────────────────┐
│ ← Configure WiFi          │
├────────────────────────────┤
│                            │
│      ✗ Failed              │
│                            │
│ Board did not connect      │
│ within 30 seconds.         │
│ Check WiFi credentials.   │
│                            │
│ ┌────────────────────────┐ │
│ │     Retry             │ │
│ └────────────────────────┘ │
└────────────────────────────┘
```

## BLE Service Specification

```mermaid
graph TD
    subgraph "BLE GATT"
        SERVICE[Service UUID<br/>6e400001-b5a3-...]
        TX[Characteristic TX<br/>6e400002-...<br/>Notify]
        RX[Characteristic RX<br/>6e400003-...<br/>Write]
    end

    MOBILE -->|Write| RX
    TX -->|Notify| MOBILE
```

**Service UUID:** `6e400001-b5a3-f393-e0a9-e50e24dcca9e`

**Characteristics:**
| UUID | Name | Properties |
|------|------|------------|
| 6e400002-... | TX | Notify |
| 6e400003-... | RX | Write |

## Configuration Data Format

### Write to BLE RX Characteristic

```json
{
  "ssid": "MyWiFiNetwork",
  "password": "password123",
  "serverUrl": "ws://192.168.1.100:10008/ws/board"
}
```

## Flow Diagram

```mermaid
sequenceDiagram
    participant App
    participant BLE
    participant ESP
    participant Server

    App->>BLE: Start Scan (with service UUID)
    BLE-->>App: Device list

    App->>App: User selects device
    App->>BLE: Connect to device
    BLE-->>App: Connected

    App->>App: User enters WiFi config
    App->>BLE: Write JSON to RX char
    BLE->>ESP: Save to NVS

    ESP->>ESP: Connect Wi-Fi
    ESP->>Server: WebSocket REGISTER (MAC address)
    Server->>Server: Save Board to DB

    loop Poll every 3s (max 30s)
        App->>Server: GET /api/boards/onboarding?mac=...
        Server-->>App: { registered: true, board: {...} }
    end

    App->>App: Show onboarding complete
```

## Key Features

1. **BLE Scanning**
   - Scan for devices with Nexio service UUID
   - Display device name and MAC address

2. **BLE Connection**
   - Connect to selected ESP32 device
   - Discover services and characteristics

3. **Configuration Input**
   - WiFi SSID input
   - WiFi password input
   - Server URL input (editable)

4. **Data Transmission**
   - Write JSON configuration to BLE
   - Receive success/failure notification

5. **Settings Persistence**
   - Save server URL locally
   - Auto-fill on next launch

## Error Handling

| Error | Action |
|-------|--------|
| BLE not available | Show error message |
| Device not found | Show "No devices found" |
| Connection failed | Show error, retry option |
| Write failed | Show error, retry option |
| Timeout | Show timeout message |