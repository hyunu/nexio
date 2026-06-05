# Nexio System Architecture

> ESP32 Wireless UART Bridge — Product(P) ↔ Client(C) 무선 중계 시스템

---

## 1. System Overview

```
┌─────────┐  UART   ┌───────────┐  Wi-Fi/WS  ┌────────┐  WebSocket  ┌──────────┐
│ Product │◄──────►│ ESP32-C3 │◄─────────►│ Server │◄──────────►│ Client   │
│ (P)     │ Binary  │ (B)       │  JSON+B64  │ (S)    │  JSON+B64  │ (C)      │
└─────────┘         └───────────┘            └────────┘            └──────────┘
                                               │    ▲
                                    BLE        │    │ REST
                                  ┌────────────┘    └────────────┐
                                  ▼                              ▼
                           ┌──────────┐                  ┌──────────────┐
                           │ Phone    │                  │ Web Dashboard│
                           │ (A)      │                  │ (FS)         │
                           └──────────┘                  └──────────────┘
```

### Data Direction

| 경로 | 방향 | 프로토콜 | 인코딩 |
|------|------|----------|--------|
| P ↔ B | 양방향 | UART Binary | Raw bytes |
| B ↔ S | 양방향 | WebSocket JSON | Base64 |
| S ↔ C | 양방향 | WebSocket JSON | Base64 |

---

## 2. Project Layout

```
nexio/
├── SYSTEM.md                          # ← 본 문서 (시스템 전체 구조)
├── design.md                          # 시스템 개요 설계
├── requirements.md                    # 전체 요구사항 명세
├── docker-compose.yml                 # MySQL 8.0 + Server
│
├── firmware/                          # ESP32-C3 Arduino 펌웨어
│   ├── design.md                      #   펌웨어 상세 설계
│   ├── firmware.ino                   #   메인 루프 (setup/loop)
│   └── src/                           #   모듈: ble, wifi, websocket, uart, display, base64
│
├── apps/
│   ├── server/                        # Node.js 중계 서버
│   │   ├── design.md                  #   서버 상세 설계
│   │   ├── src/index.ts               #   Fastify + ws + Prisma
│   │   ├── prisma/schema.prisma       #   Board/Client/Session 스키마
│   │   └── Dockerfile
│   │
│   ├── client/                        # Electron 데스크탑 클라이언트 (C)
│   │   ├── design.md                  #   클라이언트 상세 설계
│   │   ├── src/renderer/App.tsx       #   React UI
│   │   ├── src/main.ts                #   Electron main (SerialPort + WS)
│   │   └── src/preload.ts             #   IPC bridge
│   │
│   ├── web/                           # React 웹 대시보드 (FS)
│   │   ├── design.md                  #   웹 대시보드 상세 설계
│   │   ├── src/App.tsx                #   Boards/Clients/Sessions 관리
│   │   └── src/main.tsx
│   │
│   ├── mobile/                        # Flutter BLE 온보딩 앱 (A)
│   │   ├── design.md                  #   모바일 앱 상세 설계
│   │   ├── lib/main.dart
│   │   ├── lib/screens/               #   Home, Config 화면
│   │   ├── lib/ble/                   #   BLE 스캐너
│   │   └── lib/services/              #   Storage service
│   │
│   └── pc-config/                     # Electron 시리얼 설정 앱
│       ├── design.md                  #   PC Config 상세 설계
│       ├── src/renderer/App.tsx       #   WiFi/Server URL 설정 UI
│       ├── src/main.ts                #   SerialPort 통신
│       └── lib/                       #   (Flutter 버전, 미사용)
│
└── packages/
    └── shared-types/                  # 공통 TypeScript 타입
        ├── src/messages.ts            #   전체 메시지 타입 정의
        └── src/constants.ts           #   상수 (경로, UUID, 인터벌 등)
```

---

## 3. Component Relationship Matrix

| Component | Language/Framework | Connects To | Purpose |
|-----------|-------------------|-------------|---------|
| **Firmware (B)** | C++ (Arduino) | Product (UART), Server (WS) | UART ↔ Wi-Fi 브릿지 |
| **Server (S)** | TypeScript, Fastify, ws | Board, Client, Web, MySQL | 메시지 중계 + 세션 관리 |
| **Client (C)** | TypeScript, Electron, React | Server (WS), Serial Device | 서버 ↔ 시리얼포트 브릿지 |
| **Web (FS)** | TypeScript, React, Vite | Server (REST) | 모니터링/관리 대시보드 |
| **Mobile (A)** | Dart, Flutter | ESP32 (BLE), Server (REST) | Wi-Fi 온보딩 + 등록 확인 |
| **PC Config** | TypeScript, Electron, React | ESP32 (Serial) | Wi-Fi 설정 (BLE 대체) |
| **shared-types** | TypeScript | Server, Client, Web | 공통 메시지 타입 |

---

## 4. Communication Protocols

### 4.1 WebSocket Message Flow

```
Board ──REGISTER─────► Server ──REQUEST_BOARD──► Client
       ◄──ASSIGN_ID──         ◄──BOARD_READY──
       ◄──BOARD_READY─
       ◄──CONTROL────         ◄──CONTROL──────
       ◄──HEARTBEAT───         ◄──HEARTBEAT───
       ──HEARTBEAT───►         ──HEARTBEAT───►
       ──DATA_RELAY──►         ──DATA_RELAY──►
       ◄──DATA_RELAY──         ◄──DATA_RELAY──
```

### 4.2 Message Types

| Message | Source | Target | Purpose |
|---------|--------|--------|---------|
| `REGISTER` | Board | Server | 최초 접속 등록 (MAC 주소 기반) |
| `ASSIGN_ID` | Server | Board | 고유 ID 발급 (BOARD-XXXX) |
| `HEARTBEAT` | Both | Both | 연결 유지 (30s) |
| `DATA_RELAY` | Both | Both | 페이로드 중계 (Base64) |
| `REQUEST_BOARD` | Client | Server | IDLE 보드 요청 |
| `BOARD_READY` | Server | Both | 세션 할당 완료 |
| `CONTROL` | Server | Both | RESET/DISCONNECT/PING |
| `AVAILABLE_BOARDS` | Server | Client | IDLE 보드 목록 |
| `ERROR` | Server | Client | 에러 코드 반환 |

### 4.3 Board State Machine

```
        BLE 온보딩
            │
            ▼
      ┌──────────┐
      │ BLE_WAIT │────Wi-Fi Config 수신──►┌────────────┐
      └──────────┘                        │ WIFI_CONNECT│
                                          └──────┬─────┘
                                                 │ 연결 성공
                                                 ▼
                                          ┌──────────────┐
                                          │ WS_CONNECT   │──REGISTER──►┌──────────┐
                                          └──────┬───────┘            │ ASSIGN_ID│
                                                 │ ASSIGN_ID 수신     └────┬─────┘
                                                 ▼                        │
                                          ┌──────────┐                   │
                                          │   IDLE   │◄──────────────────┘
                                          └────┬─────┘
                                               │ 세션 할당
                                               ▼
                                          ┌──────────┐
                                          │   BUSY   │──데이터 중계 (DATA_RELAY)
                                          └────┬─────┘
                                               │ 세션 만료/종료
                                               ▼
                                          ┌──────────┐
                                          │   IDLE   │
                                          └──────────┘
                                               │
                                               │ 연결 끊김 / RESET
                                               ▼
                                          ┌──────────┐
                                          │ OFFLINE  │──► Wi-Fi 재연결
                                          └──────────┘
```

---

## 5. Database Schema (Prisma)

```mermaid
erDiagram
    Board ||--o{ Session : has
    Client ||--o{ Session : has

    Board {
        String id PK               "UUID"
        String uniqueId UK         "BOARD-0001"
        String macAddress          "AA:BB:CC:DD:EE:FF"
        String status             "IDLE | BUSY | OFFLINE"
        String firmwareVersion?
        Boolean displayAvailable
        DateTime connectedAt
        DateTime updatedAt
    }

    Client {
        String id PK               "UUID"
        String clientId UK         "CLIENT-xxx"
        String status             "CONNECTED | DISCONNECTED"
        DateTime connectedAt
        DateTime updatedAt
    }

    Session {
        String id PK               "UUID"
        String boardId FK
        String clientId FK
        DateTime assignedAt
        DateTime expiresAt
        String status             "ACTIVE | EXPIRED | TERMINATED"
    }
```

---

## 6. Component Detail Maps

### 6.1 Firmware (ESP32-C3)

```
firmware.ino
├── setup()
│   ├── initDisplay()         ← TFT 초기화
│   ├── initBLE()             ← GATT 서버 시작
│   └── loadConfig()
│       ├── true  → connectWiFi()
│       └── false → startBLEAdvertising()
│
└── loop()
    ├── handleBLE()           ← BLE write 이벤트 처리
    ├── WiFi 상태 체크
    │   ├── 연결됨 → webSocketClient.loop()
    │   └── 끊김   → reconnectWiFi()
    ├── heartbeat (30s)
    └── handleUART()          ← UART → WS 중계
```

**모듈:** `ble.cpp` (GATT Server), `wifi.cpp` (NVS 저장/연결), `websocket.cpp` (WS Client), `uart.cpp` (Serial read/write), `display.cpp` (TFT), `base64.cpp`

### 6.2 Server

```
src/index.ts
│
├── Fastify HTTP (:10008)
│   ├── GET  /api/health
│   ├── GET  /api/boards
│   ├── GET  /api/boards/idle
│   ├── GET  /api/boards/onboarding?mac=...  ← 모바일 온보딩 확인
│   ├── GET  /api/clients
│   ├── POST /api/sessions        ← 수동 세션 생성
│   ├── DELETE /api/sessions/:id  ← 세션 종료
│   └── POST /api/control          ← RESET/DISCONNECT
│
├── WebSocket Server
│   ├── /ws/board
│   │   └── handleBoardMessage()
│   │       ├── REGISTER  → DB 저장 → ASSIGN_ID 응답
│   │       ├── HEARTBEAT → 타이머 리셋
│   │       └── DATA_RELAY → 연결된 Client로 전달
│   │
│   └── /ws/client
│       └── handleClientMessage()
│           ├── REQUEST_BOARD → IDLE 보드 할당 → BOARD_READY
│           ├── HEARTBEAT → 타이머 리셋
│           └── DATA_RELAY → 연결된 Board로 전달
│
├── Heartbeat Service (60s timeout)
├── Session Expiry Check (60s interval)
└── In-Memory Maps
    ├── boardConnections  Map<uniqueId, WebSocket>
    └── clientConnections Map<clientId, WebSocket>
```

### 6.3 Client (Electron)

```
src/renderer/App.tsx
│
├── WebSocket Connection
│   ├── connect(url) → /ws/client
│   ├── send(data)   → IPC로 main 프로세스 위임
│   └── onMessage    → BOARD_READY / DATA_RELAY / ERROR
│
├── Serial Port
│   ├── list()       → port 목록 조회
│   ├── open(path, baudRate)
│   ├── write(data)  → 시리얼 출력
│   ├── onData       → Base64 → Server 전송
│   └── close()
│
├── Data Flow
│   Serial → Base64 Encode → DATA_RELAY(C_TO_B) → Server
│   Server → DATA_RELAY(B_TO_C) → Base64 Decode → Serial
│
└── UI Components
    ├── Server Connection Panel
    ├── Serial Port Panel (port select + baud rate)
    ├── Board Status Panel (boardId, session expiry)
    └── Data Log Panel (text/hex mode)
```

### 6.4 Web Dashboard

```
src/App.tsx
│
├── Data Polling (5s interval)
│   ├── GET /api/boards   → Board 목록
│   └── GET /api/clients  → Client 목록
│
├── Features
│   ├── Board/Client 테이블 (상태 색상 표시)
│   ├── 세션 생성 (Board + Client 선택 → POST /api/sessions)
│   └── CONTROL 전송 (RESET / DISCONNECT 버튼)
│
└── Status Colors
    IDLE 🟢 | BUSY 🟡 | OFFLINE 🔴 | CONNECTED 🟢 | DISCONNECTED 🔴
```

### 6.5 Mobile App (Flutter)

```
lib/
├── main.dart                   ← App entry
├── screens/
│   ├── home_screen.dart        ← BLE scan + device list
│   └── config_screen.dart      ← WiFi 입력 + BLE 전송 + 서버 온보딩 확인
├── ble/
│   └── ble_scanner.dart        ← flutter_blue_plus wrapper
└── services/
    ├── storage_service.dart    ← Server URL 저장 (SharedPreferences)
    └── server_service.dart     ← 서버 REST API 호출 (온보딩 폴링)
```

**BLE GATT:**
- Service UUID: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- RX (Write): `6e400003-...` ← JSON 전송
- TX (Notify): `6e400002-...` → ACK 수신

**온보딩 플로우:**
1. BLE Write → ESP32에 WiFi 설정 전송
2. ESP32 → WiFi 연결 → Server REGISTER
3. App → Server REST 폴링 (`GET /api/boards/onboarding?mac=...`)
4. Server가 보드 등록 확인 → App에 "Onboarding Complete" 표시
5. 타임아웃(30s) 시 실패 처리

### 6.6 PC Config App

```
src/renderer/App.tsx
│
├── Serial Port Connection
│   ├── Port 선택 + Baud Rate (115200)
│   └── Open/Close/Refresh
│
├── Configuration Form
│   ├── WiFi SSID
│   ├── WiFi Password
│   └── Server URL
│
└── JSON 전송
    {"ssid": "...", "password": "...", "serverUrl": "..."}
```

---

## 7. Configuration & Environment

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | 10008 | 서버 포트 |
| `DATABASE_URL` | `mysql://root:qwer1234@localhost:3306/nexio_db` | DB URL |
| `HEARTBEAT_INTERVAL_MS` | 30000 | 하트비트 주기 |
| `HEARTBEAT_TIMEOUT_MS` | 60000 | 하트비트 타임아웃 |
| `DEFAULT_SESSION_DURATION` | 3600 | 세션 기본 점유 시간 (초) |

---

## 8. Startup Sequence

```
1. docker-compose up
   ├── MySQL 8.0 (:3306)
   └── Server  (:10008)
       ├── Prisma Migrate (테이블 생성)
       ├── Fastify HTTP API
       └── WebSocket Server (ws/board, ws/client)

2. ESP32 전원 ON
   ├── BLE 대기 (초기 설정 없을 시)
   │   └── Mobile/PC Config → WiFi 정보 전송
   ├── Wi-Fi 연결
   ├── WebSocket → REGISTER → ASSIGN_ID 수신
   └── IDLE 상태 대기

3. Client 실행
   ├── WebSocket 연결 (/ws/client)
   ├── 시리얼 포트 오픈
   ├── REQUEST_BOARD 전송
   └── BOARD_READY 수신 → 데이터 중계 시작

4. Dashboard 접속
   └── http://localhost:10008 → 모니터링/제어
```
