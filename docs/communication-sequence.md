# Communication Sequence Diagrams

## 1. BLE Provisioning (Factory Reset → Onboarding)

```mermaid
sequenceDiagram
    participant Board as ESP32-C3 Board
    participant iPhone as iOS App
    participant Server as Nexio Server

    Note over Board: FACTORY_RESET → clearConfig(), ESP.restart()
    Board->>Board: initBLE(), startBLEAdvertising()
    Note over Board: Advertising as "Nexio" (no uniqueId)

    iPhone->>Board: BLE Connect
    iPhone->>Board: BLE Write: {ssid, password, serverUrl, uniqueId}
    Board->>Board: onWiFiConfigured()
    Board->>Board: saveConfig(), setBleUniqueId(uniqueId)
    Board->>Board: connectWiFi()

    Board->>Board: WiFi connected, registered=false

    loop Every 3s until success
        Board->>Server: HTTP POST /api/board/message
        Note right of Board: {type:"REGISTER", boardId, uniqueId}
        Server->>Server: Find or create board record
        alt preAssignedId exists
            Server->>Server: Find by uniqueId
            alt Board found & not DISCARDED
                Server->>Server: Update status IDLE, macAddress, etc.
            else Board not found or DISCARDED
                Server->>Server: Create new board record
            end
        else no preAssignedId
            Server->>Server: Find by macAddress
            alt Board found & not DISCARDED
                Server->>Server: Update status IDLE
            else Board not found or DISCARDED
                Server->>Server: Create new board with generated uniqueId
            end
        end
        Server-->>Board: {commands, uniqueId}
    end

    Board->>Board: registered=true, setBleUniqueId(uniqueId), updateStatusFlags()
    Board->>Board: Start heartbeats
    Note over Board: BLE advertising name → "Nexio-0004"
```

## 2. Heartbeat & Command Delivery

```mermaid
sequenceDiagram
    participant Board as ESP32-C3 Board
    participant Server as Nexio Server
    participant Admin as Management Page

    loop Every HEARTBEAT_INTERVAL (3s)
        Board->>Server: HTTP POST /api/board/message
        Note right of Board: {type:"HEARTBEAT", id:uniqueId}
        Server->>Server: resetHeartbeatTimer()
        Server->>Server: Get pending commands from boardCommandQueues
        Server-->>Board: {commands: [...]}
        Board->>Board: Process each command
    end

    Note over Admin,Server: Admin sends command
    Admin->>Server: POST /api/control (or discard, etc.)
    Server->>Server: sendToBoard() → queues command
    Server-->>Admin: {success:true}

    Note over Board: Next heartbeat picks up command
    Board->>Server: HTTP POST /api/board/message (HEARTBEAT)
    Server-->>Board: {commands: [{type:"CONTROL", action:"RESET", ...}]}
    Board->>Board: Execute CONTROL action
```

## 3. DISCARD Flow (New)

```mermaid
sequenceDiagram
    participant Admin as Management Page
    participant Server as Nexio Server
    participant Board as ESP32-C3 Board

    Admin->>Server: POST /api/boards/0004/discard
    Server->>Server: Set board status = DISCARDED
    Server->>Server: sendToBoard() → queue DISCARD command
    Server-->>Admin: {success:true, discarded:true}

    Note over Board: Gets command on next HEARTBEAT
    Board->>Server: HTTP POST /api/board/message (HEARTBEAT)
    Server-->>Board: {commands: [{type:"CONTROL", action:"DISCARD", ...}]}

    Board->>Board: Send DISCARD_ACK to server
    Board->>Server: HTTP POST /api/board/message
    Note right of Board: {type:"DISCARD_ACK", id:"0004"}
    Server->>Server: prisma.board.delete(uniqueId:"0004")
    Server->>Server: Clear command queue & WS connection
    Server-->>Board: {success:true}

    Board->>Board: clearConfig()
    Board->>Board: ESP.restart()
    Note over Board: Boots fresh, BLE advertising as "Nexio"
```

## 4. DISCARDED Board Re-registration

When a DISCARDED board (that never received the DISCARD command) tries to REGISTER:

```mermaid
sequenceDiagram
    participant Board as ESP32-C3 Board
    participant Server as Nexio Server

    Board->>Server: HTTP POST /api/board/message
    Note right of Board: {type:"REGISTER", boardId, uniqueId:"0004"}

    Server->>Database: Find board by uniqueId "0004"
    Database-->>Server: Board record (status:DISCARDED)

    Server->>Database: prisma.board.delete(id:oldBoard.id)
    Server->>Database: prisma.board.create(...)
    Note right of Server: Creates fresh board with uniqueId "0004"

    Server-->>Board: {commands, uniqueId:"0004"}
    Board->>Board: registered=true, continue normally
```

## 5. MAC Conflict Resolution

After FACTORY_RESET, the board re-registers with the same MAC but potentially different uniqueId:

```mermaid
sequenceDiagram
    participant Board as ESP32-C3 Board
    participant Server as Nexio Server
    participant Database as MySQL

    Note over Board: MAC: 88:56:A6:7D:0A:B0, uniqueId:"0004"

    Board->>Server: HTTP POST /api/board/message
    Note right of Board: {type:"REGISTER", boardId:MAC, uniqueId:"0004"}

    Server->>Database: Find board by uniqueId "0004"
    Database-->>Server: Board record (id:A, uniqueId:"0004", macAddress:null)

    alt Another board has same MAC
        Server->>Database: UPDATE Board SET macAddress=NULL WHERE macAddress=MAC AND id≠A
        Note right of Server: Clears stale MAC from old board
    end

    Server->>Database: UPDATE Board SET macAddress=MAC, status=IDLE WHERE id=A
    Server-->>Board: {commands, uniqueId:"0004"}
```

## 6. Data Relay (UART → Server → Client)

```mermaid
sequenceDiagram
    participant Product as Connected Product
    participant Board as ESP32-C3 Board
    participant Server as Nexio Server
    participant Client as Client App

    Product->>Board: UART Data
    Board->>Board: base64_encode()
    Board->>Server: HTTP POST /api/board/message
    Note right of Board: {type:"DATA_RELAY", sessionId, payload, direction:"B_TO_C"}

    Server->>Database: Find session by sessionId
    Server->>Server: Find client WS connection
    Server-->>Client: WebSocket Message (DATA_RELAY)
    Client-->>Server: WebSocket Response
    Server-->>Board: {success:true}
```

## 7. Onboarding Claim Flow

```mermaid
sequenceDiagram
    participant App as iOS App
    participant Server as Nexio Server
    participant Database as MySQL

    Note over App: User scans QR code / enters MAC

    App->>Server: GET /api/boards/onboarding?mac=XX:XX:XX:XX:XX:XX
    Server->>Database: Find board by macAddress
    alt Board exists & status is IDLE or BUSY
        Database-->>Server: Board record
        Server-->>App: {registered:true, board:{uniqueId, status}}
    else Board not found
        Server-->>App: {registered:false}
    end

    App->>Server: POST /api/onboarding/claim
    Note right of App: {macAddress: "XX:XX:XX:XX:XX:XX"}

    alt Board exists
        Server->>Database: UPDATE status = CLAIMED
        Database-->>Server: OK
        Server-->>App: {uniqueId}
    else Board not exists
        Server->>Database: Create new board with generated uniqueId
        Database-->>Server: OK
        Server-->>App: {uniqueId}
    end

    App->>Board: BLE Write: {ssid, password, serverUrl, uniqueId}
    Note over App,Board: Provisioning complete
```
