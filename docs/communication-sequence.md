# 통신 시퀀스 다이어그램

## BLE 알림 메시지 색상 범례

Phone 앱의 로그 패널에 표시되는 BLE 알림 메시지의 색상 구분:

| 태그 | 색상 | 의미 | 발생 시점 |
|------|------|------|----------|
| `[BOOT]` | 회색 (#94a3b8) | 시스템 부팅/초기화 | `setup()` 실행 시 |
| `[CFG]` | 파랑 (#3b82f6) | 설정 수신/저장 | BLE Write 수신 후 |
| `[WIFI]` | 초록 (#22c55e) | WiFi 연결 성공 | WiFi 연결 완료 |
| `[WIFI]` | 빨강 (#ef4444) | WiFi 연결 실패 | WiFi 타임아웃/암호 오류 |
| `[SVR]` | 보라 (#8b5cf6) | 서버 등록 성공 | ASSIGN_ID 수신 |
| `[SVR]` | 빨강 (#ef4444) | 서버 등록 실패 | REGISTER HTTP 오류 |
| `[WS]` | 청록 (#06b6d4) | WebSocket 연결/해제 | WS 연결 성공 또는 끊김 |
| `[CMD]` | 주황 (#f59e0b) | BLE 명령 수신 확인 | Phone이 RESET/DISCARD 전송 시 |

---

## 1. BLE 온보딩 (설정 전 → 등록 완료)

```mermaid
sequenceDiagram
    participant Phone as iOS App
    participant Board as ESP32-C3 Board
    participant Server as Nexio Server
    participant DB as MySQL

    Note over Board: 설정 없이 부팅
    Board->>Board: initBLE, startBLEAdvertising
    Note over Board: "Nexio"로 광고 (flags=0x00)

    rect rgb(100, 116, 139)
        Board->>Phone: BLE Notify: [BOOT] BLE advertising started
    end

    Phone->>Board: BLE 연결
    Phone->>Board: BLE discoverServices (캐싱)

    Phone->>Server: POST /api/onboarding/claim
    Note right of Phone: macAddress 전송
    Server->>DB: 보드 조회 또는 생성
    DB-->>Server: uniqueId (기존 또는 max+1)
    Server-->>Phone: uniqueId

    Phone->>Board: BLE Write: ssid, password, serverUrl, uniqueId
    Board->>Board: onWiFiConfigured
    Board->>Board: saveConfig, setBleUniqueId

    rect rgb(59, 130, 246)
        Board->>Phone: BLE Notify: [CFG] Config received: hyunu_2.4Ghz
    end

    Board->>Board: connectWiFi (disconnect + WIFI_STA)

    Note over Board: WiFi 연결 시도

    alt WiFi 연결 성공
        Board->>Board: WiFi 연결됨
        rect rgb(34, 197, 94)
            Board->>Phone: BLE Notify: [WIFI] Connected to hyunu_2.4Ghz, IP: 192.168.0.x
        end

        Board->>Server: WebSocket 연결 (/ws/board)

        rect rgb(6, 182, 212)
            Board->>Phone: BLE Notify: [WS] Connected
        end

        Board->>Server: WebSocket REGISTER (1회)
        Note right of Board: type REGISTER, boardId, uniqueId, productConnected

        alt 서버 등록 성공
            Server-->>Board: WebSocket ASSIGN_ID
            Note right of Server: uniqueId, serverTime
            Board->>Board: registered = true, heartbeat 시작
            Board->>Board: setBleUniqueId, updateStatusFlags
            Note over Board: BLE 이름 => Nexio-uniqueId, flags 갱신

            rect rgb(139, 92, 246)
                Board->>Phone: BLE Notify: [SVR] Registered as 0004
            end

        else 서버 등록 실패 (HTTP 오류 등)
            rect rgb(239, 68, 68)
                Board->>Phone: BLE Notify: [SVR] Register FAILED, retrying...
            end
        end

    else WiFi 연결 실패
        alt 네트워크 없음
            rect rgb(239, 68, 68)
                Board->>Phone: BLE Notify: [WIFI] Network not found
            end
        else 암호 오류
            rect rgb(239, 68, 68)
                Board->>Phone: BLE Notify: [WIFI] Wrong password
            end
        else 타임아웃
            rect rgb(239, 68, 68)
                Board->>Phone: BLE Notify: [WIFI] Connection timeout
            end
        end
    end

    loop Phone이 등록 확인 polling (3초 간격, 최대 30초)
        Phone->>Server: GET /api/boards/onboarding?mac=MAC
        alt 보드 상태 IDLE 또는 BUSY
            Server-->>Phone: registered true, 보드 정보
            Phone->>Phone: 온보딩 완료
        else CLAIMED 또는 없음
            Server-->>Phone: registered false
            Phone->>Phone: 계속 polling
        end
    end
```

## 2. 하트비트 및 명령 전달

```mermaid
sequenceDiagram
    participant Board as ESP32-C3 Board
    participant Server as Nexio Server
    participant Admin as 대시보드 or API

    loop HEARTBEAT_INTERVAL (30초) 마다
        Board->>Server: WebSocket HEARTBEAT
        Note right of Board: type HEARTBEAT, id uniqueId
        Server->>Server: resetHeartbeatTimer
        Server-->>Board: WebSocket HEARTBEAT (pong)
    end

    Note over Admin,Server: 관리자 명령 발생
    Admin->>Server: POST /api/control 또는 /api/boards/id/discard

    Note over Server: 명령을 보드의 WebSocket으로 즉시 push
    Server->>Board: WebSocket CONTROL(DISCARD)
    Server->>Board: WebSocket CONTROL(RESET)
    Server->>Board: WebSocket DATA_RELAY (C_TO_B)

    Board->>Board: 명령을 수신 즉시 처리
    alt RESET
        Board->>Board: ESP.restart
    else DISCARD
        Board->>Board: DISCARD_ACK 전송
        Board->>Server: WebSocket DISCARD_ACK
        Board->>Board: clearConfig, ESP.restart
    else DISCONNECT
        Board->>Board: 무시
    end
```

## 3. HTTP 기반 DISCARD 플로우 (대시보드)

```mermaid
sequenceDiagram
    participant Admin as 대시보드
    participant Server as Nexio Server
    participant Board as ESP32-C3 Board

    Admin->>Server: POST /api/boards/0004/discard
    Server->>Server: waitForDiscardAck(0004, 5000)

    Server->>Board: WebSocket CONTROL(DISCARD) (즉시 push)
    Note right of Server: heartbeat 대기 없음

    Board->>Board: DISCARD_ACK 전송
    Board->>Server: WebSocket DISCARD_ACK
    Note right of Board: type DISCARD_ACK, id 0004
    Server->>Server: waiter.resolve(true)
    Server->>Server: board.delete(uniqueId 0004)
    Server->>Server: WS 연결 및 큐 정리

    Board->>Board: clearConfig

    rect rgb(6, 182, 212)
        Board->>Phone: BLE Notify: [WS] Disconnected
    end

    Board->>Board: ESP.restart

    Note over Server: 5초 타임아웃 후 (ACK 받든 못 받든)
    Server-->>Admin: success, discarded true, ackReceived true/false
    Note over Server: 보드 레코드는 무조건 삭제
```

## 4. BLE 기반 DISCARD 플로우 (Phone)

```mermaid
sequenceDiagram
    participant Phone as iOS App
    participant Board as ESP32-C3 Board
    participant Server as Nexio Server

    Note over Phone: 사용자가 공장 초기화 버튼 탭
    Phone->>Board: BLE Write: {"action":"DISCARD"}

    Board->>Board: blePendingAction = DISCARD

    rect rgb(249, 115, 22)
        Board->>Phone: BLE Notify: [CMD] DISCARD
    end

    Board->>Board: clearConfig

    rect rgb(6, 182, 212)
        Board->>Phone: BLE Notify: [WS] Disconnected
    end

    Board->>Board: ESP.restart

    Note over Phone: BLE notify 수신, 보드 재시작 중
    Phone->>Server: POST /api/boards/uniqueId/discard
    Note over Phone: BLE 이름에서 uniqueId 추출 (Nexio-0004)

    Server->>Server: sendToBoard(DISCARD) - 보드 오프라인이라 무효
    Server->>Server: waitForDiscardAck 타임아웃 (5초)
    Server->>Server: board.delete(uniqueId 0004)
    Server-->>Phone: success, discarded true, ackReceived false
```

## 5. DISCARDED 보드 재등록

```mermaid
sequenceDiagram
    participant Board as ESP32-C3 Board
    participant Server as Nexio Server
    participant DB as MySQL

    Note over Board: DISCARD 명령을 받지 못한 보드
    Note over Board: 예전 설정과 uniqueId 그대로 보유

    Board->>Server: WebSocket 연결 (/ws/board)

    rect rgb(6, 182, 212)
        Board->>Phone: BLE Notify: [WS] Connected
    end

    Board->>Server: WebSocket REGISTER
    Note right of Board: type REGISTER, boardId, uniqueId 0004

    Server->>DB: uniqueId 0004 로 조회
    DB-->>Server: status DISCARDED 인 레코드

    Server->>DB: 기존 DISCARDED 레코드 삭제
    Server->>DB: 새로운 보드 레코드 생성 (같은 uniqueId)
    Note right of Server: uniqueId 0004 유지, 내부 ID는 새로 발급

    Server-->>Board: WebSocket ASSIGN_ID
    Note right of Server: uniqueId 0004
    Board->>Board: registered = true, 정상 동작
```

## 6. MAC 충돌 해결

```mermaid
sequenceDiagram
    participant Board as ESP32-C3 Board
    participant Server as Nexio Server
    participant DB as MySQL

    Note over Board: MAC: 88:56:A6:7D:0A:B0, uniqueId: 0004
    Note over Board: BLE MAC과 WiFi MAC은 마지막 옥텟이 1 차이

    Board->>Server: WebSocket 연결 (/ws/board)

    rect rgb(6, 182, 212)
        Board->>Phone: BLE Notify: [WS] Connected
    end

    Board->>Server: WebSocket REGISTER
    Note right of Board: type REGISTER, boardId MAC, uniqueId 0004

    Server->>DB: uniqueId 0004 로 조회
    DB--->>Server: 보드 레코드 존재

    alt 다른 보드가 같은 MAC 사용 중
        Server->>DB: UPDATE macAddress = NULL
        Note right of Server: WHERE macAddress = MAC AND id != 현재
    end

    Server->>DB: UPDATE macAddress = MAC, status = IDLE
    DB-->>Server: OK
    Server-->>Board: WebSocket ASSIGN_ID
    Server-->>Board: WebSocket HEARTBEAT (pong) 시작
```

## 7. 데이터 중계 (양방향)

```mermaid
sequenceDiagram
    participant Product as 연결된 제품
    participant Board as ESP32-C3 Board
    participant Server as Nexio Server
    participant Client as 클라이언트 앱

    Note over Product,Client: 제품 → 클라이언트 (B_TO_C)

    Product->>Board: UART 바이너리 데이터
    Board->>Board: base64 인코딩
    Board->>Board: lastServerMessage 갱신
    Board->>Server: WebSocket DATA_RELAY
    Note right of Board: type DATA_RELAY, sessionId, payload, direction B_TO_C

    Server->>Server: sessionId 로 세션 조회
    Server->>Server: 클라이언트 WS 연결 찾기
    Server-->>Client: WebSocket DATA_RELAY 전달
    Server->>Server: broadcastToMonitor

    Note over Client: base64 디코딩 후 시리얼 포트로 출력

    Note over Product,Client: 클라이언트 → 제품 (C_TO_B)

    Client->>Server: WebSocket DATA_RELAY 전송
    Note right of Client: type DATA_RELAY, sessionId, payload, direction C_TO_B

    Server->>Server: 세션과 보드 조회
    Server->>Board: WebSocket DATA_RELAY (즉시 push)
    Note right of Server: heartbeat 대기 없음

    Board->>Board: base64 디코딩
    Board->>Product: UART 바이너리 데이터 출력
```

## 8. 온보딩 Claim 플로우

```mermaid
sequenceDiagram
    participant Phone as iOS App
    participant Server as Nexio Server
    participant DB as MySQL

    Note over Phone: BLE로 설정되지 않은 보드에 연결됨

    Phone->>Server: POST /api/onboarding/claim
    Note right of Phone: macAddress XX:XX:XX:XX:XX:XX

    alt 기존 보드 레코드 있음
        Server->>DB: UPDATE status = CLAIMED
        DB-->>Server: OK
        Server-->>Phone: 기존 uniqueId 반환
    else 신규 보드
        Server->>DB: 최대 uniqueId 조회 후 max+1 생성
        DB-->>Server: OK
        Server-->>Phone: 새 uniqueId 반환
    end

    Note over Phone: 발급받은 uniqueId를 BLE Write로 보드에 전송

    loop 3초 간격으로 최대 30초 polling
        Phone->>Server: GET /api/boards/onboarding?mac=MAC
        Server->>DB: macAddress로 보드 조회

        alt status IDLE 또는 BUSY (보드 등록 완료)
            DB-->>Server: 보드 레코드
            Server-->>Phone: registered true, uniqueId, status
            Phone->>Phone: 온보딩 완료 화면 표시
            Note over Phone: polling 종료
        else 없거나 CLAIMED/OFFLINE
            DB-->>Server: null
            Server-->>Phone: registered false
            Phone->>Phone: 계속 polling
        end
    end

    alt 타임아웃
        Phone->>Phone: 실패 메시지 표시
        Note over Phone: 30초 내 보드 등록 실패
    end
```

## 9. 서버 기동 복구

```mermaid
sequenceDiagram
    participant Server as Nexio Server
    participant DB as MySQL

    Note over Server: 서버 시작
    Server->>DB: UPDATE Board SET status = OFFLINE
    Note right of Server: WHERE status IN (IDLE, BUSY)

    DB-->>Server: OK

    Note over Server: 보드들은 기존 WebSocket이 끊겨 자동 재연결 시도
    Note over Server: 60초마다 checkExpiredSessions 실행
    Server->>DB: ACTIVE 세션 중 expiresAt < now 조회
    DB-->>Server: 만료된 세션 목록
    Server->>Server: EXPIRED 처리, 보드 IDLE 전환, board/client 통지
```

## 10. BLE 알림 메시지 전체 목록

펌웨어에서 Phone으로 BLE TX characteristic을 통해 전송하는 모든 알림 메시지:

| 순서 | 태그 | 메시지 | 발생 조건 | Phone 화면 색상 |
|------|------|--------|----------|---------------|
| 1 | `[BOOT]` | `BLE advertising started` | `setup()`에서 BLE 광고 시작 | 회색 |
| 2 | `[BOOT]` | `Config loaded` | `setup()`에서 기존 설정 발견 (재부팅 시) | 회색 |
| 3 | `[CFG]` | `Config received: {SSID}` | Phone에서 BLE Write로 설정 수신 | 파랑 |
| 4 | `[WIFI]` | `Connected to {SSID}, IP: {IP}` | WiFi 연결 성공 | 초록 |
| 5 | `[WIFI]` | `Network not found` | WiFi AP를 찾을 수 없음 | 빨강 |
| 6 | `[WIFI]` | `Wrong password` | WiFi 암호 오류 | 빨강 |
| 7 | `[WIFI]` | `Connection timeout` | WiFi 연결 시간 초과 | 빨강 |
| 8 | `[SVR]` | `Registered as {uniqueId}` | 서버 등록 성공 (ASSIGN_ID 수신) | 보라 |
| 9 | `[SVR]` | `Register FAILED, retrying...` | 서버 등록 HTTP 오류 | 빨강 |
| 10 | `[WS]` | `Connected` | WebSocket 서버 연결 성공 | 청록 |
| 11 | `[WS]` | `Disconnected` | WebSocket 연결 끊김 | 청록 |
| 12 | `[CMD]` | `{action}` | BLE 명령어 수신 확인 (RESET/DISCARD) | 주황 |
