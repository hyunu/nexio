

///////////////////////////////////////////////////////////////////////////////////////////////////
//
//
//          [1] 전방부 — Includes, Macros, 전역 변수, 전방 선언
//
//
/////////////////////////////////////////////////////////////////////////////////////////////////////


#include <Arduino.h>
#include <NimBLEDevice.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

#define LED_PIN              8
#define WIFI_TIMEOUT_MS      15000

// ── 제품 UART (Serial1) ──────────────────────────────────────────────
#define PRODUCT_UART_TX      21
#define PRODUCT_UART_RX      20
#define PRODUCT_UART_BAUD    115200

// ── UART RX 링 버퍼 ──────────────────────────────────────────────────
static const size_t  UART_BUF_SIZE    = 1024;             // 버퍼 크기 (bytes)
static       uint8_t uartRing[UART_BUF_SIZE];             // 링 버퍼 저장소
static       size_t  uartHead         = 0;                // 다음 쓰기 위치 (생산자)
static       size_t  uartTail         = 0;                // 다음 읽기 위치 (소비자)

// ── BLE GATT UUID ────────────────────────────────────────────────────
static const char* SERVICE_UUID  = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
static const char* CHAR_TX_UUID  = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";  // 보드 → 폰 (notify)
static const char* CHAR_RX_UUID  = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";  // 폰 → 보드 (write)

// ── 온보딩 / 연결 상태 ──────────────────────────────────────────────
static char           gUniqueId[32]       = {0};           // 서버가 할당한 ID (예: "0042")
static char           gServerHost[64]     = {0};           // 파싱된 WS 호스트 (포트 제외)
static uint16_t       gServerPort         = 0;             // 파싱된 WS 포트
static bool           gOnboarded          = false;         // NVS에 Wi-Fi 설정 보관 중
static uint8_t        gStatusFlags        = 0;             // BLE mfg data 비트마스크
static bool           gWifiConnected      = false;         // Wi-Fi 링크 연결됨
static bool           gWifiAttempted      = false;         // Wi-Fi.begin() 호출됨
static unsigned long  gWifiAttemptTime    = 0;             // 마지막 Wi-Fi 연결 시도 시각
static bool           gRegistered         = false;         // 서버가 ASSIGN_ID 전송 완료
static bool           gBleConnected       = false;         // BLE 링크 연결됨
static bool           gBleAdvertising     = false;         // BLE 광고 중
static volatile bool  gPendingRestart     = false;         // RESET/DISCARD → loop()에서 소비

// ── WebSocket 상태 ──────────────────────────────────────────────────
static bool           gWsConnected       = false;          // WS 링크 연결됨
static unsigned long  gWsConnectStart    = 0;              // gWs.begin() 호출 시각 (ms)

// ── 핸들 ────────────────────────────────────────────────────────────
static NimBLECharacteristic*  pTxChar  = nullptr;          // BLE notify 특성
static WebSocketsClient       gWs;                          // WS 클라이언트 인스턴스
static Preferences            prefs;                        // NVS 핸들

// ── 주기 타이머 ─────────────────────────────────────────────────────
static unsigned long  gLastServerMsg  = 0;                 // 마지막 서버 HEARTBEAT 수신 시각
static unsigned long  gLastRegister   = 0;                 // 마지막 REGISTER 전송 시각

// ── 전방 선언 ──────────────────────────────────────────────────────
static void startBLEAdvertising();
static void bleNotify(const char* msg);
static void updateStatusFlags();
static void wifiConnect(const char* ssid, const char* pass);
static void wsToUart(const char* payload, size_t len);


///////////////////////////////////////////////////////////////////////////////////////////////////
//
//
//          [2] BLE   — NimBLE 서버/콜백, 알림, 광고, 상태 플래그 
//
//
///////////////////////////////////////////////////////////////////////////////////////////////////


//-----------------------------------------------------------------------------
// SvrCb: BLE 서버 접속/해제 콜백
//-----------------------------------------------------------------------------
class SvrCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo&) override {
    Serial.println("[BLE] Connected");
    gBleConnected = true;
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    Serial.println("[BLE] Disconnected");
    gBleConnected = false;
    startBLEAdvertising();
  }
};

//-----------------------------------------------------------------------------
// RxCb: BLE 쓰기 콜백 (모바일 앱 → 보드)
// action:   RESET / DISCARD
// config:   ssid + password + serverUrl + uniqueId
//-----------------------------------------------------------------------------
class RxCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pc, NimBLEConnInfo&) override {
    std::string val = pc->getValue();
    Serial.printf("[BLE_RX] %s\n", val.c_str());
    const char* d = val.c_str();

    // 액션 명령 처리 ────────────────────────────────────────────────
    const char* ap = strstr(d, "\"action\":\"");
    if (ap) {
      const char* s = ap + 10;
      const char* e = strchr(s, '"');
      if (e) {
        char act[32];
        size_t l = e - s;
        if (l < sizeof(act)) {
          memcpy(act, s, l);
          act[l] = '\0';
          char buf[64];
          snprintf(buf, sizeof(buf), "[CMD] %s", act);
          bleNotify(buf);
          if      (strcmp(act, "RESET")   == 0) gPendingRestart = true;
          else if (strcmp(act, "DISCARD") == 0) {
            prefs.begin("nexio", false);
            prefs.clear();
            prefs.end();
            gPendingRestart = true;
          }
        }
      }
      return;
    }

    // 설정(config) 파싱 ──────────────────────────────────────────────
    char ssid[64]  = {0};
    char pass[64]  = {0};
    char url[128]  = {0};
    char uid[32]   = {0};

    #define EXTRACT(tag, buf, off) do {                \
      const char* _f = strstr(d, "\"" tag "\":\"");    \
      if (_f) {                                        \
        const char* _s = _f + off;                     \
        const char* _e = strchr(_s, '"');              \
        if (_e && (size_t)(_e - _s) < sizeof(buf)) {   \
          memcpy((void*)buf, _s, _e - _s);             \
          buf[_e - _s] = '\0';                         \
        }                                              \
      }                                                \
    } while(0)

    EXTRACT("ssid",      ssid,  8);
    EXTRACT("password",  pass, 12);
    EXTRACT("serverUrl", url,  13);
    EXTRACT("uniqueId",  uid,  12);

    #undef EXTRACT

    if (ssid[0] && pass[0] && url[0]) {
      // 수신 내용 로그 ──────────────────────────────────────────────
      Serial.println("===== CONFIG RECEIVED =====");
      Serial.printf("  ssid:      [%s]\n", ssid);
      Serial.printf("  password:  [%s]\n", pass);
      Serial.printf("  serverUrl: [%s]\n", url);
      Serial.printf("  uniqueId:  [%s]\n", uid);
      Serial.println("===========================");

      char buf[192];
      snprintf(buf, sizeof(buf), "[CFG] ssid=%s pass=%s url=%s uid=%s",
               ssid, pass, url, uid);
      bleNotify(buf);

      if (uid[0])
        strncpy(gUniqueId, uid, sizeof(gUniqueId) - 1);

      // NVS에 저장 ──────────────────────────────────────────────────
      prefs.begin("nexio", false);
      prefs.putString("ssid", ssid);
      prefs.putString("pass", pass);
      prefs.putString("url",  url);
      prefs.putString("uid",  gUniqueId);
      prefs.end();

      // 서버 URL → host + port ──────────────────────────────────────
      int pp  = 0;
      int ps  = strstr(url, "://") ? (strstr(url, "://") - (char*)url + 3) : 0;
      char* lastColon = strrchr(url, ':');
      if (lastColon) pp = lastColon - url + 1;

      if (ps > 0 && pp > ps) {
        strncpy(gServerHost, url + ps, sizeof(gServerHost) - 1);

        char* colon = strrchr(gServerHost, ':');  // 호스트에서 포트 제거
        if (colon) *colon = '\0';

        char* slash = strchr(gServerHost, '/');   // 호스트에서 후행 / 제거
        if (slash) *slash = '\0';

        gServerPort = atoi(url + pp);
      }

      gOnboarded = true;
      updateStatusFlags();

      // 이미 같은 SSID로 Wi-Fi 연결 중이면 생략
      if (WiFi.status() != WL_CONNECTED || strcmp(WiFi.SSID().c_str(), ssid) != 0)
        wifiConnect(ssid, pass);
    }
  }
};

static SvrCb _svrCb;
static RxCb  _rxCb;

//-----------------------------------------------------------------------------
// bleNotify: BLE 알림 전송
// BLE 연결 상태면 notification으로 전송, USB CDC에는 항상 출력
//-----------------------------------------------------------------------------
static void bleNotify(const char* msg) {
  if (gBleConnected && pTxChar) {
    pTxChar->setValue(msg);
    pTxChar->notify();
  }
  Serial.println(msg);
}

//-----------------------------------------------------------------------------
// startBLEAdvertising: BLE 광고 시작
//-----------------------------------------------------------------------------
static void startBLEAdvertising() {
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->stop();

  char name[48];
  if (gUniqueId[0])
    snprintf(name, sizeof(name), "Nexio-%s", gUniqueId);
  else
    strncpy(name, "Nexio", sizeof(name) - 1);
  NimBLEDevice::setDeviceName(name);

  // Manufacturer data: 회사 ID(0x02D5) + 상태 플래그
  uint8_t mfg[5] = {
    (uint8_t)(0x02D5 & 0xFF),
    (uint8_t)(0x02D5 >> 8),
    gStatusFlags, 0x00, 0x00
  };
  adv->setManufacturerData(mfg, 5);
  adv->start();
  gBleAdvertising = true;
  bleNotify("[BLE] Advertising started");
}

//-----------------------------------------------------------------------------
// updateStatusFlags: 상태 플래그 갱신
//   Bit 1 (0x02) = SVR  — 서버 등록 완료
//   Bit 2 (0x04) = WIFI — Wi-Fi 연결됨
//   Bit 3 (0x08) = CFG  — 설정 보유
// 플래그가 바뀌면 BLE 광고 데이터를 다시 내보내 스캐너가 새 상태를 감지
//-----------------------------------------------------------------------------
static void updateStatusFlags() {
  uint8_t f = 0;
  if (gRegistered)     f |= 0x02;
  if (gWifiConnected)  f |= 0x04;
  if (gOnboarded)      f |= 0x08;
  if (f != gStatusFlags) {
    gStatusFlags = f;
    if (gBleAdvertising) startBLEAdvertising();
  }
}


///////////////////////////////////////////////////////////////////////////////////////////////////
//
//
//          [3] Wi-Fi — 연결/재연결  
//
//
///////////////////////////////////////////////////////////////////////////////////////////////////


//-----------------------------------------------------------------------------
// wifiConnect: Wi-Fi 연결 시작
//-----------------------------------------------------------------------------
static void wifiConnect(const char* ssid, const char* pass) {
  char buf[128];
  snprintf(buf, sizeof(buf), "[WIFI] Connecting to %s...", ssid);
  bleNotify(buf);
  WiFi.disconnect(true);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);
  gWifiAttempted   = true;
  gWifiAttemptTime  = millis();
}


///////////////////////////////////////////////////////////////////////////////////////////////////
//
//
//          [4] WS    — WebSocket 송수신 (REGISTER, HEARTBEAT, 이벤트 처리)   
//
//
///////////////////////////////////////////////////////////////////////////////////////////////////


//-----------------------------------------------------------------------------
// sendRegister: REGISTER 전송
//-----------------------------------------------------------------------------
static void sendRegister() {
  char out[384];
  char bid[18];
  strncpy(bid, WiFi.macAddress().c_str(), sizeof(bid) - 1);
  bid[sizeof(bid) - 1] = '\0';

  int p = snprintf(out, sizeof(out),
    "{\"type\":\"REGISTER\",\"version\":\"1.0\",\"timestamp\":%lu,"
    "\"boardId\":\"%s\",\"firmwareVersion\":\"1.0.0\","
    "\"displayAvailable\":false,\"productConnected\":false",
    millis(), bid);
  if (gUniqueId[0])
    p += snprintf(out + p, sizeof(out) - p, ",\"uniqueId\":\"%s\"", gUniqueId);
  snprintf(out + p, sizeof(out) - p, "}");

  gWs.sendTXT(out);
}

//-----------------------------------------------------------------------------
// sendHeartbeat: HEARTBEAT 전송
//-----------------------------------------------------------------------------
static void sendHeartbeat() {
  char out[256];
  int len = snprintf(out, sizeof(out),
    "{\"type\":\"HEARTBEAT\",\"version\":\"1.0\",\"timestamp\":%lu", millis());
  if (gUniqueId[0])
    len += snprintf(out + len, sizeof(out) - len, ",\"id\":\"%s\"", gUniqueId);
  snprintf(out + len, sizeof(out) - len, "}");
  gWs.sendTXT(out);
}

//-----------------------------------------------------------------------------
// wsEvent: WS 이벤트 핸들러
// 수신 메시지 종류: ASSIGN_ID, HEARTBEAT, CONTROL, DATA_RELAY
//-----------------------------------------------------------------------------
static void wsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      bleNotify("[WS] Connected");
      gWsConnected    = true;
      gWsConnectStart = 0;
      gRegistered     = false;
      gLastRegister   = 0;
      break;

    case WStype_DISCONNECTED:
      if (gWsConnected) bleNotify("[WS] Disconnected");
      gWsConnected = false;
      gRegistered  = false;
      break;

    case WStype_TEXT: {
      StaticJsonDocument<512> doc;
      if (deserializeJson(doc, payload, length) != DeserializationError::Ok)
        return;

      const char* type = doc["type"];
      if (!type) return;

      // ASSIGN_ID: 서버가 등록 확인 ──────────────────────────────────
      if (strcmp(type, "ASSIGN_ID") == 0) {
        const char* nid = doc["uniqueId"];
        if (nid && strlen(nid) > 0) {
          strncpy(gUniqueId, nid, sizeof(gUniqueId) - 1);
          prefs.begin("nexio", false);
          prefs.putString("uid", gUniqueId);
          prefs.end();
        }
        if (!gRegistered) {
          gRegistered = true;
          char buf[64];
          snprintf(buf, sizeof(buf), "[SVR] Registered as %s", gUniqueId);
          bleNotify(buf);
        }
        updateStatusFlags();

      // HEARTBEAT: 서버 생존 신호 ───────────────────────────────────
      } else if (strcmp(type, "HEARTBEAT") == 0) {
        gLastServerMsg = millis();

      // CONTROL: 서버가 보낸 액션 ────────────────────────────────────
      } else if (strcmp(type, "CONTROL") == 0) {
        const char* action = doc["action"];
        if (!action) return;
        if (strcmp(action, "RESET") == 0) {
          gPendingRestart = true;
        } else if (strcmp(action, "DISCARD") == 0) {
          char out[256];
          int p = snprintf(out, sizeof(out),
            "{\"type\":\"DISCARD_ACK\",\"timestamp\":%lu", millis());
          if (gUniqueId[0])
            p += snprintf(out + p, sizeof(out) - p, ",\"id\":\"%s\"", gUniqueId);
          snprintf(out + p, sizeof(out) - p, "}");
          gWs.sendTXT(out);
          delay(5);
          prefs.begin("nexio", false);
          prefs.clear();
          prefs.end();
          gPendingRestart = true;
        }

      // DATA_RELAY: 서버 → 제품 UART 전달 ──────────────────────────
      } else if (strcmp(type, "DATA_RELAY") == 0) {
        const char* payload = doc["payload"];
        if (payload) wsToUart(payload, strlen(payload));
      }
      break;
    }

    case WStype_PING:
    case WStype_PONG:
    default:
      break;
  }
}


///////////////////////////////////////////////////////////////////////////////////////////////////
//
//
//          [5] UART  — UART ↔ WS 중계 (링 버퍼, HEX 인코딩/디코딩)    
//
//
///////////////////////////////////////////////////////////////////////////////////////////////////


//-----------------------------------------------------------------------------
// uartToWs: 제품 UART → 서버
// Serial1 바이트를 링 버퍼에 읽어들인 후 WS 연결 시 DATA_RELAY(HEX) 전송
//-----------------------------------------------------------------------------
static void uartToWs() {
  while (Serial1.available()) {
    uint8_t b      = Serial1.read();
    size_t  next   = (uartHead + 1) % UART_BUF_SIZE;
    if (next != uartTail) {
      uartRing[uartHead] = b;
      uartHead           = next;
    }
  }

  if (uartHead == uartTail || !gWsConnected || !gRegistered)
    return;

  size_t avail = (uartHead >= uartTail)
                   ? (uartHead - uartTail)
                   : (UART_BUF_SIZE - uartTail);
  if (avail > 240) avail = 240;  // WS 프레임 크기 제한

  // HEX 인코딩
  char hex[512];
  int pos = 0;
  for (size_t i = 0; i < avail && pos < (int)sizeof(hex) - 12; i++)
    pos += snprintf(hex + pos, sizeof(hex) - pos, "%02X",
                    uartRing[(uartTail + i) % UART_BUF_SIZE]);

  uartTail = (uartTail + avail) % UART_BUF_SIZE;

  char out[640];
  snprintf(out, sizeof(out),
    "{\"type\":\"DATA_RELAY\",\"payload\":\"%s\",\"direction\":\"uart_to_server\"}",
    hex);
  gWs.sendTXT(out);
}

//-----------------------------------------------------------------------------
// wsToUart: 서버 → 제품 UART
// DATA_RELAY HEX payload를 디코딩하여 Serial1로 출력
//-----------------------------------------------------------------------------
static void wsToUart(const char* payload, size_t len) {
  for (size_t i = 0; i + 1 < len; i += 2) {
    char h[3] = { payload[i], payload[i + 1], '\0' };
    char* end  = nullptr;
    uint8_t b  = strtoul(h, &end, 16);
    if (*end == '\0') Serial1.write(b);
  }
  Serial1.flush();
}


///////////////////////////////////////////////////////////////////////////////////////////////////
//
//
//          [6] 초기화 — setup()     
//
//
///////////////////////////////////////////////////////////////////////////////////////////////////


void setup() {
  Serial.begin(115200);
  Serial1.begin(PRODUCT_UART_BAUD, SERIAL_8N1, PRODUCT_UART_RX, PRODUCT_UART_TX);
  pinMode(LED_PIN, OUTPUT);

  // 저장된 설정 복원 ──────────────────────────────────────────────────
  prefs.begin("nexio", true);
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  String url  = prefs.getString("url",  "");
  String uid  = prefs.getString("uid",  "");
  prefs.end();

  if (ssid.length() > 0) {
    strncpy(gUniqueId, uid.c_str(), sizeof(gUniqueId) - 1);
    gOnboarded = true;

    int ps = url.indexOf("://");
    int pp = url.lastIndexOf(":");
    if (ps > 0 && pp > ps) {
      strncpy(gServerHost, url.substring(ps + 3, pp).c_str(),
              sizeof(gServerHost) - 1);
      gServerPort = url.substring(pp + 1).toInt();
    }

    wifiConnect(ssid.c_str(), pass.c_str());
  }

  // BLE 초기화 ────────────────────────────────────────────────────────
  NimBLEDevice::init("Nexio");

  NimBLEServer* pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(&_svrCb);

  NimBLEService* svc = pServer->createService(SERVICE_UUID);
  pTxChar = svc->createCharacteristic(CHAR_TX_UUID, NIMBLE_PROPERTY::NOTIFY);
  NimBLECharacteristic* pRxChar =
    svc->createCharacteristic(CHAR_RX_UUID,
                              NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  pRxChar->setCallbacks(&_rxCb);
  svc->start();

  startBLEAdvertising();
}


///////////////////////////////////////////////////////////////////////////////////////////////////
//
//
//          [7] 루프   — loop()  
//
//
///////////////////////////////////////////////////////////////////////////////////////////////////


void loop() {
  // RESET / DISCARD 처리 ──────────────────────────────────────────────
  if (gPendingRestart) {
    gPendingRestart = false;
    delay(100);
    ESP.restart();
  }

  gWs.loop();                           // WS 송수신 처리
  uartToWs();                           // UART → WS 전달

  // Wi-Fi: 연결 감지 ─────────────────────────────────────────────────
  if (WiFi.status() == WL_CONNECTED && !gWifiConnected) {
    gWifiConnected   = true;
    gWifiAttempted   = false;
    updateStatusFlags();

    char buf[128];
    snprintf(buf, sizeof(buf), "[WIFI] Connected to %s, IP: %s, MAC: %s",
             WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(),
             WiFi.macAddress().c_str());
    bleNotify(buf);

    if (gServerHost[0] && gServerPort > 0) {
      gWs.begin(gServerHost, gServerPort, "/ws/board");
      gWs.onEvent(wsEvent);
      gWsConnected    = false;
      gWsConnectStart = millis();
    }
  }

  // Wi-Fi: 끊김 감지 ─────────────────────────────────────────────────
  if (WiFi.status() != WL_CONNECTED && gWifiConnected) {
    gWifiConnected   = false;
    gRegistered      = false;
    gWifiAttempted   = true;
    gWifiAttemptTime  = millis();
    updateStatusFlags();
    gWs.disconnect();
    gWsConnected    = false;
    gWsConnectStart = 0;
  }

  // Wi-Fi: 타임아웃 / 재시도 ─────────────────────────────────────────
  if (!gWifiConnected && gWifiAttempted &&
      millis() - gWifiAttemptTime > WIFI_TIMEOUT_MS) {
    gWifiAttempted = false;
    bleNotify("[WIFI] Connection failed (timeout)");
  }
  if (!gWifiConnected && !gWifiAttempted && gOnboarded) {
    prefs.begin("nexio", true);
    String ssid = prefs.getString("ssid", "");
    String pass = prefs.getString("pass", "");
    prefs.end();
    if (ssid.length() > 0) wifiConnect(ssid.c_str(), pass.c_str());
  }

  // WS: 재연결 감시 ───────────────────────────────────────────────────
  // Wi-Fi는 연결됐는데 WS가 5초 이상 안 잡히면 gWs.begin() 재호출
  if (gWifiConnected && gServerHost[0] && !gWsConnected &&
      gWsConnectStart > 0 &&
      millis() - gWsConnectStart > 5000) {
    bleNotify("[WS] Reconnecting...");
    gWs.disconnect();
    delay(50);
    gWs.begin(gServerHost, gServerPort, "/ws/board");
    gWs.onEvent(wsEvent);
    gWsConnectStart = millis();
  }

  // REGISTER: ack 받을 때까지 3초 간격 재시도 ──────────────────────
  if (gWifiConnected && gWsConnected && !gRegistered && gServerHost[0] &&
      millis() - gLastRegister > 3000) {
    gLastRegister = millis();
    sendRegister();
  }

  // HEARTBEAT: 5초 간격; 서버 타임아웃 9초 ──────────────────────────
  if (gWifiConnected && gRegistered &&
      millis() - gLastServerMsg > 5000) {
    gLastServerMsg = millis();
    sendHeartbeat();
  }

  // LED 표시 ───────────────────────────────────────────────────────────
  digitalWrite(LED_PIN, WiFi.status() == WL_CONNECTED ? HIGH : LOW);

  delay(100);
}

