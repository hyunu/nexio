# Nexio System Architecture

> ESP32 Wireless UART Bridge — Product(P) ↔ Client(C) 무선 중계 시스템

---

## 1. System Overview

```
  ─── DATA PATH ───────────────────────────────────────────────
  Product    UART Binary   ESP32-C3    Wi-Fi/WS     Server    WS     Client
  (P)       ◄──────────►   (B)       ◄──────────►   (S)    ◄───►   (C)

  ─── MANAGEMENT ──────────────────────────────────────────────
  Mobile App (A) ──BLE──► ESP32(B)   : WiFi 설정 + uniqueId 전송
  Mobile App (A) ──REST─► Server(S)  : uniqueId claim + 온보딩 polling
  Web Dashboard  ──REST─► Server(S)  : boards/clients/sessions 관리
  (FS)

  ─── LEGEND ──────────────────────────────────────────────────
  Binary : raw bytes           B64 : Base64 encoded
  WS     : WebSocket JSON      BLE : Bluetooth Low Energy
  REST   : HTTP API (JSON)     UART : Serial (TX=7, RX=6, 19200 기본, 온보딩 시 변경 가능)
```

### Data Direction

| 경로 | 방향 | 프로토콜 | 인코딩 |
|------|------|----------|--------|
| P ↔ B | 양방향 | UART Binary | Raw bytes |
| B ↔ S | 양방향 | WebSocket JSON | Base64 |
| S ↔ C | 양방향 | WebSocket JSON | Base64 |
| A → B | 단방향 | BLE (GATT Write) | JSON |
| A ↔ S | 양방향 | REST API | JSON |
| FS → S | 단방향 | REST API | JSON |

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
│       ├── src/preload.ts             #   IPC 브릿지 (server:claim, server:checkOnboarding)
│       └── src/main.ts                #   SerialPort 통신 + REST API IPC
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
| `ASSIGN_ID` | Server | Board | 고유 ID 발급 (숫자 4자리) |
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

### 4.4 BLE Advertisement Structure

**Advertisement Data (31B):**
```
[3B]  Flags                  02 01 06
[18B] Service UUID (128bit)   11 06 [16B UUID]
[10B] Manufacturer Data       08 FF [CompanyID 2B] [FLAGS] [Version] [Reserved]
```
- Company ID: `0x02D5` (Espressif)
- Flags byte (bitmask): `PRD=0x01 | SVR=0x02 | WiFi=0x04 | CFG=0x08`
- Version byte: `0x01`
- Service UUID만으로 필터링, Manufacturer Data로 상태 식별

**Scan Response (31B, phone scan request 시):**
```
[13B] Full Name "Nexio-0042"   0C 09 4E 65 78 69 6F 2D 30 30 34 32
```
- 미설정 시: `"Nexio"` (7B)
- 설정 후: `"Nexio-{uniqueId}"` (13B)

**Status Flags (1 byte):**

| Bit | Mask | Name | 의미 |
|-----|------|------|------|
| 0 | `0x01` | PRD | UART 제품 연결됨 |
| 1 | `0x02` | SVR | WebSocket 서버 연결됨 |
| 2 | `0x04` | WiFi | Wi-Fi 연결됨 |
| 3 | `0x08` | CFG | 온보딩 완료 (설정 있음) |

**예시 상태값:**

| Flags | 상태 | 의미 |
|-------|------|------|
| `0x00` | ⚪ Unconfigured | 설정 전, BLE 대기 |
| `0x08` | 🟡 Configuring | 설정만 있음, Wi-Fi 연결 중 |
| `0x0C` | 🟡 Connecting | Wi-Fi 연결됨, 서버 연결 대기 |
| `0x0E` | 🟡 Connected | Wi-Fi+서버 연결, 제품 미연결 |
| `0x0F` | 🟢 Full Connected | 모두 정상 |
| `0x04` | 🔴 WiFi Only | Wi-Fi만 연결됨 (비정상) |

### 4.5 BLE ON/OFF Strategy

```
전원 ON
├── 설정 없음 → BLE ON (flags=0x00, SCAN_RSP="Nexio")
├── 설정 있음 → WiFi 연결 시도
│   ├── 서버 연결 성공 + 제품 연결 → BLE OFF
│   └── WiFi/서버/제품 연결 끊김 → BLE fallback ON (flags=현재상태)
```

### 4.6 UART Keep-Alive

- 제품(P)의 UART RX 30초 타임아웃 기반 연결 모니터링
- 10초마다 프로브 바이트(0x00) 전송
- `PRD` 플래그는 RX 수신 여부로 결정

---

## 5. Database Schema (Prisma)

```mermaid
erDiagram
    Board ||--o{ Session : has
    Client ||--o{ Session : has

    Board {
        String id PK               "UUID"
        String uniqueId UK         "0042"
        String macAddress UK       "AA:BB:CC:DD:EE:FF"
        String status             "IDLE | BUSY | OFFLINE | CLAIMED"
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
│   ├── initBLE()             ← GATT 서버 + ADV/SCAN_RSP 준비
│   └── loadConfig()
│       ├── true  → setBleUniqueId() → connectWiFi()
│       └── false → startBLEAdvertising()
│
└── loop() (매 iteration)
    ├── handleBLE()           ← BLE write 이벤트 처리
    ├── handleUART()          ← UART → WS 중계 + RX 타임스탬프
    ├── WiFi 상태 체크 / reconnectWebSocket()
    ├── webSocketClient.loop() + sendHeartbeat() (30s)
    ├── isProductConnected() + sendProductProbe() (10s)
    ├── updateStatusFlags()   ← 4개 비트를 종합해 BLE ADV 갱신
    └── BLE fallback ON/OFF   ← 온보딩+연결되면 OFF, 끊기면 ON
    └── rebuildDisplay()      ← 2초마다 LCD 갱신

updateStatusFlags()
  └── PRD=isProductConnected()
      SVR=wsConnected
      WiFi=wifiConnected
      CFG=onboarded
      → setBleStatus(flags) → updateAdvertising()
```

**BLE ON/OFF 전환:** 설정 완료 + WiFi + WS + 제품 모두 연결 시 BLE OFF. 하나라도 끊기면 BLE ON.

**DISPLAY 통합 화면 (240x240):**
```
┌──────────────────────┐
│ Nexio                │  ← 흰색, size 2
│ ID: 0042             │  ← 청록, size 1
│                      │
│ WiFi ● MyHomeNet     │  ← 초록/빨강 원 + SSID
│ SVR  ●               │  ← 초록/빨강 원
│ PRD  ●               │  ← 초록/빨강 원
│                      │
│ BLE waiting...       │  ← 미설정 시 노랑
│ Use Nexio App        │
└──────────────────────┘
```

**모듈:** `ble.cpp` (GATT Server + ADV/SCAN_RSP), `wifi.cpp` (NVS 저장/연결), `websocket.cpp` (WS Client), `uart.cpp` (Serial read/write + keep-alive), `display.cpp` (TFT 통합 상태), `base64.cpp`

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
│   ├── POST /api/onboarding/claim            ← 고유번호 발급 (숫자 4자리)
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
│   ├── home_screen.dart        ← BLE scan + device list (상태 표시)
│   └── config_screen.dart      ← WiFi 입력 + BLE 전송 + 서버 온보딩 확인
├── ble/
│   └── ble_scanner.dart        ← flutter_blue_plus wrapper + AD flags 파싱
└── services/
    ├── storage_service.dart    ← Server URL 저장 (SharedPreferences)
    └── server_service.dart     ← 서버 REST API 호출 (온보딩 폴링)
```

**BLE GATT:**
- Service UUID: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- RX (Write): `6e400003-...` ← JSON 전송
- TX (Notify): `6e400002-...` → ACK 수신

**Device 상태 표시 (home_screen):**

| 상태 | 색상 | 의미 | 탭 가능? |
|------|------|------|---------|
| `unconfigured` | ⚪ 회색 | 설정 전 | ✅ ConfigScreen 이동 |
| `configuring` | 🟡 주황 | 설정 전송됨, WiFi 연결 중 | ❌ |
| `connecting` | 🟡 주황 | WiFi 연결, 서버 대기 | ❌ |
| `connected` | 🟡 노랑 | WiFi+서버 연결 | ❌ |
| `fullConnected` | 🟢 초록 | 모두 정상 | ❌ |
| `wifiOnly` | 🔴 빨강 | WiFi만 연결 (비정상) | ❌ |

**온보딩 플로우:**
1. 서버 `POST /api/onboarding/claim` → 고유번호(숫자 4자리) 발급
2. BLE Write (JSON) → ESP32에 WiFi + 고유번호 전송
3. ESP32 → WiFi 연결 → Server REGISTER
4. App → Server REST 폴링 (`GET /api/boards/onboarding?mac=...`, 30s timeout)
5. Server가 보드 등록 확인 → App에 "Onboarding Complete" 표시

### 6.6 PC Config App

Electron 데스크톱 앱. 모바일 BLE 온보딩의 대체 수단으로, USB 시리얼(UART)을 통해 ESP32에 WiFi 설정을 전송한다.

```
src/renderer/App.tsx
│
├── Serial Port Connection
│   ├── Port 선택 + Baud Rate (19200 기본)
│   └── Open/Close/Refresh
│
├── Configuration Form
│   ├── WiFi SSID
│   ├── WiFi Password
│   ├── Server URL
│   └── MAC Address (선택)
│
├── Onboarding Flow (claim → send → wait)
│   ├── 1. Server POST /api/onboarding/claim → uniqueId 발급
│   ├── 2. 시리얼 JSON 전송 (ssid + password + serverUrl + uniqueId)
│   └── 3. Server GET /api/boards/onboarding?mac=... 폴링 (30s)
│
└── Log Window
    ├── 전송/수신 데이터
    └── 상태 메시지
```

**온보딩 JSON 포맷:**
```json
{"ssid":"...","password":"...","serverUrl":"ws://.../ws/board","uniqueId":"0042"}
```

**주의:** ESP32 펌웨어가 UART로 수신한 JSON 설정을 파싱하여 `onWiFiConfigured()`를 호출하도록 추가 구현 필요. (현재 UART 핸들러는 모든 데이터를 제품(P) 데이터로 간주하여 서버로 전달함)

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
   ├── 설정 없음 → BLE ON (flags=0x00, SCAN_RSP="Nexio")
   │   └── Mobile/PC Config → WiFi 정보 전송 → 고유번호 발급
   ├── 설정 있음 → BLE SCAN_RSP="Nexio-0042"
   ├── Wi-Fi 연결
   ├── WebSocket → REGISTER → ASSIGN_ID 수신
   ├── 서버+제품 연결 시 BLE OFF
   └── IDLE 상태 대기

3. Client 실행
   ├── WebSocket 연결 (/ws/client)
   ├── 시리얼 포트 오픈
   ├── REQUEST_BOARD 전송
   └── BOARD_READY 수신 → 데이터 중계 시작

4. Dashboard 접속
   └── http://localhost:10008 → 모니터링/제어
```

---

## 9. Key Protocol Details

### uniqueId Format
- 이전: `BOARD-0042` (프리픽스 + 4자리 숫자)
- 현재: `0042` (순수 4자리 숫자, `String(count+1).padStart(4,'0')`)

### BLE Name Resolution
- Phone이 Scan Request를 보내면 ESP32가 SCAN_RSP로 응답
- 미설정: `"Nexio"`
- 설정 후: `"Nexio-{uniqueId}"` (예: `Nexio-0042`)

### UART Keep-Alive Parameters
- `PRODUCT_TIMEOUT_MS`: 30000 (30초간 RX 없으면 연결 끊김)
- `PRODUCT_PROBE_INTERVAL_MS`: 10000 (10초마다 프로브 0x00 전송)
- 제품 측 펌웨어 변경 불필요 (RX 기반 모니터링)

