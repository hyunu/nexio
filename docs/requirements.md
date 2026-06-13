# 프로젝트 개발 프롬프트 — ESP32 무선 UART 브릿지 시스템

> Cursor / GitHub Copilot 에 이 문서를 컨텍스트로 제공하고 작업을 지시하세요.

---

## 1. 프로젝트 개요

UART 데이터를 생성하는 **제품(P)** 과 이를 소비하는 **클라이언트(C)** 사이를 무선으로 연결하는 시스템이다.
ESP32-C3 보드(B)가 P의 UART 데이터를 수신해 Wi-Fi를 통해 서버(S)로 전송하고, S는 이를 C로 실시간 중계한다.
C에서 생성한 데이터도 반대 방향(C → S → B → P)으로 전달된다.

---

## 2. 시스템 구성요소

| 구성요소 | 식별자 | 설명 |
|---|---|---|
| 제품 | P | UART 바이너리 데이터를 송수신하는 대상 기기 |
| ESP32-C3 보드 | B | QSZNTEC ESP32-C3 1.28인치 원형 스크린 개발 보드 |
| 서버 | S | 중계 서버 (백그라운드 서비스 BS + 웹페이지 FS) |
| 클라이언트 앱 | C | 서버 ↔ 시리얼포트 브릿지 데스크탑/웹 앱 |
| 폰앱 | A | BLE 기반 ESP32 온보딩 모바일 앱 |

---

## 3. 데이터 흐름 및 프로토콜

### 3-1. P ↔ B 구간
- **프로토콜**: UART (바이너리)
- B는 수신한 바이너리를 **Base64 인코딩**하여 JSON payload에 담아 S로 전송
- S → B → P 방향은 JSON payload의 Base64를 **디코딩**하여 UART로 출력

### 3-2. B ↔ S ↔ C 구간
- **프로토콜**: WebSocket (JSON)
- 모든 바이너리 데이터는 Base64 인코딩/디코딩

---

## 4. JSON 메시지 스펙 (전체 정의)

> 모든 메시지는 아래 기본 구조를 공유한다.

```json
{
  "type": "MESSAGE_TYPE",
  "version": "1.0",
  "timestamp": 1700000000000
}
```

### 4-1. B → S : REGISTER
보드가 서버에 최초 접속 시 전송

```json
{
  "type": "REGISTER",
  "version": "1.0",
  "timestamp": 1700000000000,
  "boardId": "ESP32_MAC_ADDRESS",
  "firmwareVersion": "1.0.0",
  "displayAvailable": true
}
```

### 4-2. S → B : ASSIGN_ID
서버가 보드에 고유 ID를 발급

```json
{
  "type": "ASSIGN_ID",
  "version": "1.0",
  "timestamp": 1700000000000,
  "uniqueId": "BOARD-0001",
  "serverTime": 1700000000000
}
```
- B는 이 ID를 디스플레이에 표시한다.
- 서버는 이 보드를 **IDLE(잉여)** 상태로 등록한다.

### 4-3. B/C ↔ S : HEARTBEAT
연결 유지용 핑/퐁 (30초 간격)

```json
{
  "type": "HEARTBEAT",
  "version": "1.0",
  "timestamp": 1700000000000,
  "id": "BOARD-0001"
}
```

### 4-4. B → S → C : DATA_RELAY (P에서 C 방향)
UART 데이터를 C로 중계

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

### 4-5. C → S → B : DATA_RELAY (C에서 P 방향)
클라이언트 데이터를 P로 중계

```json
{
  "type": "DATA_RELAY",
  "version": "1.0",
  "timestamp": 1700000000000,
  "sessionId": "SESSION-ABC123",
  "sourceId": "CLIENT-XYZ",
  "direction": "C_TO_B",
  "payload": "base64encodedBinaryData=="
}
```

### 4-6. C → S : REQUEST_BOARD
클라이언트가 잉여 보드 요청

```json
{
  "type": "REQUEST_BOARD",
  "version": "1.0",
  "timestamp": 1700000000000,
  "clientId": "CLIENT-XYZ",
  "sessionDuration": 3600
}
```
- `sessionDuration`: 점유 시간 (초 단위)

### 4-7. S → C : BOARD_READY
서버가 보드 할당 완료 통보

```json
{
  "type": "BOARD_READY",
  "version": "1.0",
  "timestamp": 1700000000000,
  "boardId": "BOARD-0001",
  "sessionId": "SESSION-ABC123",
  "assignedAt": 1700000000000,
  "expiresAt": 1700003600000
}
```

### 4-8. S → B 또는 S → C : CONTROL
서버가 보드 또는 클라이언트에 제어 명령 송신

```json
{
  "type": "CONTROL",
  "version": "1.0",
  "timestamp": 1700000000000,
  "targetId": "BOARD-0001",
  "action": "RESET",
  "reason": "admin_request"
}
```
- `action`: `RESET` | `DISCONNECT` | `PING`

### 4-9. S → C : AVAILABLE_BOARDS
잉여 보드 목록 응답 (클라이언트 요청에 대한 응답)

```json
{
  "type": "AVAILABLE_BOARDS",
  "version": "1.0",
  "timestamp": 1700000000000,
  "boards": [
    { "uniqueId": "BOARD-0001", "status": "IDLE", "connectedAt": 1700000000000 },
    { "uniqueId": "BOARD-0002", "status": "IDLE", "connectedAt": 1699990000000 }
  ]
}
```

### 4-10. 공통 : ERROR

```json
{
  "type": "ERROR",
  "version": "1.0",
  "timestamp": 1700000000000,
  "code": "BOARD_NOT_FOUND",
  "message": "Requested board is not available"
}
```

---

## 5. 보드 상태 머신

```
OFFLINE → ONLINE(IDLE) → ASSIGNED(BUSY) → ONLINE(IDLE)
                              ↓
                         OFFLINE (연결 끊김 또는 RESET)
```

---

## 6. 구성요소별 기술 요구사항

### 6-1. ESP32-C3 보드 펌웨어 (B)

**하드웨어**: QSZNTEC ESP32-C3 1.28인치 원형 스크린 개발 보드
**개발환경**: Arduino IDE 또는 ESP-IDF (Arduino 권장)

**기능 요구사항**
- BLE GATT 서버 구현: AP SSID, Password, 서버 URL 수신
- Wi-Fi 연결 후 WebSocket 클라이언트로 서버 접속
- UART 수신 → Base64 인코딩 → `DATA_RELAY` 전송
- `DATA_RELAY` 수신 → Base64 디코딩 → UART 송신
- `ASSIGN_ID` 수신 후 디스플레이에 uniqueId 및 Wi-Fi SSID 표시
- `CONTROL(RESET)` 수신 시 ESP.restart() 호출
- `HEARTBEAT` 30초 간격 전송
- Wi-Fi 끊김 시 자동 재연결 및 서버 재접속

**BLE 서비스 스펙**
- Service UUID: `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` (Nordic UART-like)
- Characteristic (Write): SSID / Password / Server URL (개별 또는 JSON 단건 write)

**디스플레이 표시 정보**
- Wi-Fi 연결 상태 (연결 중 / 연결됨 / 실패)
- 연결된 AP SSID
- 서버로부터 받은 고유 ID (uniqueId)
- WebSocket 연결 상태

**라이브러리 권장**
- `ArduinoWebsockets` (Markus Sattler)
- `ArduinoJson`
- `NimBLE-Arduino` (BLE)
- `TFT_eSPI` (디스플레이, GC9A01 드라이버 설정 필요)

---

### 6-2. 폰앱 (A)

**플랫폼**: Flutter (iOS + Android 동시 지원)

**기능 요구사항**
- BLE 스캔 → ESP32 보드 선택
- BLE GATT Write로 Wi-Fi SSID, Password, 서버 URL 전달
- 전달 후 보드의 Wi-Fi 연결 상태 피드백 표시
- 서버 URL은 앱 내 설정 화면에서 입력/저장 가능

**UX 흐름**
1. 앱 실행 → BLE 스캔 시작
2. 보드 목록 표시 → 선택
3. 서버 URL + Wi-Fi 정보 입력 화면
4. "전송" 버튼 → BLE Write
5. "연결 성공" 피드백 후 완료

---

### 6-3. 서버 (S)

**런타임**: Node.js (TypeScript)
**프레임워크**: Fastify (HTTP) + ws 라이브러리 (WebSocket)
**DB**: SQLite (개발) / PostgreSQL (프로덕션)
**ORM**: Prisma

**백그라운드 서비스 (BS) 기능**
- WebSocket 서버 운영 (보드 연결 / 클라이언트 연결 분리 엔드포인트)
  - `/ws/board` — 보드 전용
  - `/ws/client` — 클라이언트 전용
- 보드 등록 및 고유 ID 발급
- 보드 상태 관리 (IDLE / BUSY / OFFLINE)
- 클라이언트 요청 시 IDLE 보드 할당 및 세션 생성
- `DATA_RELAY` 메시지 양방향 중계
- 세션 점유 시간 만료 시 자동 해제
- HEARTBEAT 미수신 보드/클라이언트 자동 OFFLINE 처리 (60초 타임아웃)
- 관리자 CONTROL 명령 처리 (RESET / DISCONNECT)

**웹페이지 (FS) 기능**
- React (Vite) SPA
- 연결된 보드(B) 목록: uniqueId, 상태, 연결 시각
- 연결된 클라이언트(C) 목록: clientId, 상태, 연결 시각
- 보드-클라이언트 수동 연결 기능 (드롭다운 선택 후 "연결" 버튼)
- 연결 상태 실시간 표시 (WebSocket 또는 SSE)
- 보드/클라이언트 강제 RESET / DISCONNECT 버튼

**API 엔드포인트**
```
GET  /api/boards          — 보드 목록 조회
GET  /api/boards/idle     — 잉여 보드 목록
GET  /api/clients         — 클라이언트 목록
POST /api/sessions        — 보드-클라이언트 수동 연결
DELETE /api/sessions/:id  — 세션 해제
POST /api/control         — RESET / DISCONNECT 명령 전송
```

**DB 스키마 (Prisma)**
```prisma
model Board {
  id          String   @id
  uniqueId    String   @unique
  macAddress  String
  status      String   // IDLE | BUSY | OFFLINE
  connectedAt DateTime
  updatedAt   DateTime @updatedAt
  sessions    Session[]
}

model Client {
  id          String   @id
  clientId    String   @unique
  status      String   // CONNECTED | DISCONNECTED
  connectedAt DateTime
  updatedAt   DateTime @updatedAt
  sessions    Session[]
}

model Session {
  id          String   @id
  boardId     String
  clientId    String
  assignedAt  DateTime
  expiresAt   DateTime
  status      String   // ACTIVE | EXPIRED | TERMINATED
  board       Board    @relation(fields: [boardId], references: [id])
  client      Client   @relation(fields: [clientId], references: [id])
}
```

---

### 6-4. 클라이언트 앱 (C)

**플랫폼**: Electron (또는 Tauri) — 크로스 플랫폼 데스크탑 앱
**프론트엔드**: React + TypeScript

**기능 요구사항**
- 서버 URL 입력 및 WebSocket 연결
- 시리얼 포트 목록 표시 및 선택 UI (baud rate 설정 포함)
- 서버 연결 후 `BOARD_READY` 수신 시 자동 준비 상태 전환
- 시리얼 포트 수신 데이터 → Base64 인코딩 → `DATA_RELAY` 서버 전송
- 서버로부터 `DATA_RELAY` 수신 → Base64 디코딩 → 시리얼 포트 출력
- 연결 상태 표시: 서버 연결 / 보드 할당 / 시리얼 포트 연결

**UI 구성**
```
[서버 연결] URL 입력창 + 연결 버튼 + 상태 표시
[시리얼 포트] 포트 선택 드롭다운 + Baud Rate 선택 + 연결 버튼
[보드 상태] 할당된 보드 ID / 세션 만료 시각
[데이터 로그] 송/수신 데이터 실시간 표시 (hex or 텍스트 전환)
```

---

## 7. 설계 기준 및 공통 제약

### 7-1. 보안
- WebSocket 연결은 WSS(TLS) 사용 (개발 환경은 WS 허용)
- 보드는 MAC Address 기반 고유 식별, 서버는 uniqueId를 발급하여 관리
- 클라이언트 인증은 1차 구현에서 생략하되 추후 JWT 추가 가능하도록 설계

### 7-2. 실시간성
- `DATA_RELAY` 메시지는 수신 즉시 중계 (버퍼링 금지)
- WebSocket 지연 목표: 로컬 네트워크 기준 < 50ms

### 7-3. 재연결 처리
- 보드: Wi-Fi 끊김 시 3초 간격 재연결, WebSocket 끊김 시 5초 간격 재연결
- 클라이언트: WebSocket 끊김 시 exponential backoff (1s → 2s → 4s → 최대 30s)

### 7-4. 코드 구조
- 각 구성요소는 독립 디렉터리로 분리
- 공통 JSON 타입 정의는 `packages/shared-types`에 위치 (모노레포 권장)

```
/
├── firmware/         # ESP32-C3 Arduino 코드
├── apps/
│   ├── server/       # Node.js 서버 (BS + FS API)
│   ├── web/          # React 웹페이지 (FS)
│   ├── mobile/       # Flutter 폰앱 (A)
│   └── client/       # Electron 클라이언트 (C)
└── packages/
    └── shared-types/ # JSON 메시지 TypeScript 타입 정의
```

### 7-5. 환경 설정
- 서버 포트, DB URL, WebSocket 경로 등 모든 설정값은 `.env`로 관리
- 보드의 서버 URL은 BLE로 수신하며 NVS(Flash)에 저장

---

## 8. 구현 우선순위 (권장 순서)

1. **서버 WebSocket 기반 골격** — 보드 등록, ID 발급, 상태 관리
2. **ESP32 펌웨어** — BLE 온보딩, Wi-Fi 연결, REGISTER/ASSIGN_ID, DATA_RELAY
3. **클라이언트 앱** — 서버 연결, 시리얼 포트 연결, DATA_RELAY 송수신
4. **웹페이지** — 보드/클라이언트 모니터링, 수동 연결, CONTROL
5. **폰앱** — BLE 스캔 및 온보딩

---

## 9. Cursor 작업 지시 예시

각 단계별로 아래처럼 Cursor에 지시한다.

```
이 문서를 참고해서 apps/server/src/websocket/boardHandler.ts 를 작성해줘.
보드 WebSocket 연결 시 REGISTER 메시지를 처리하고 ASSIGN_ID를 응답하며,
보드 상태를 Prisma DB에 저장하는 코드를 구현해줘.
JSON 타입은 packages/shared-types의 정의를 사용해야 해.
```

```
firmware/ 디렉터리에 ESP32-C3 Arduino 코드를 작성해줘.
BLE GATT 서버로 SSID, Password, ServerURL을 수신하고,
Wi-Fi 연결 후 WebSocket으로 REGISTER 메시지를 보내고
ASSIGN_ID를 받아서 TFT_eSPI로 디스플레이에 표시하는 코드야.
```
