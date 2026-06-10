#include <Arduino.h>
#include <NimBLEDevice.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

#define LED_PIN              8
#define WIFI_TIMEOUT_MS  15000

// ── Product UART (Serial1) ──────────────────────────────────────────
#define PRODUCT_UART_TX      21
#define PRODUCT_UART_RX      20
#define PRODUCT_UART_BAUD 115200

// ── UART RX ring buffer ───────────────────────────────────────────
static const size_t UART_BUF_SIZE    = 1024;          // ring buffer capacity (bytes)
static       uint8_t  uartRing[UART_BUF_SIZE];        // ring buffer storage
static       size_t   uartHead       = 0;              // next write index (producer)
static       size_t   uartTail       = 0;              // next read  index (consumer)

// ── BLE GATT UUIDs ────────────────────────────────────────────────
static const char* SERVICE_UUID  = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
static const char* CHAR_TX_UUID  = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";  // ← board → phone (notify)
static const char* CHAR_RX_UUID  = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";  // ← phone → board  (write)

// ── Onboarding / connection state ─────────────────────────────────
static char    gUniqueId[32]       = {0};              // assigned by server (e.g. "0042")
static char    gServerHost[64]     = {0};              // parsed WS host (no port)
static uint16_t gServerPort         = 0;                // parsed WS port
static bool    gOnboarded          = false;             // has Wi-Fi config stored in NVS
static uint8_t gStatusFlags        = 0;                 // bitmask for BLE mfg data
static bool    gWifiConnected      = false;             // Wi-Fi link up
static bool    gWifiAttempted      = false;             // Wi-Fi.begin() called
static unsigned long gWifiAttemptTime = 0;               // timestamp of last Wi-Fi attempt
static bool    gRegistered         = false;             // server has sent ASSIGN_ID
static bool    gBleConnected       = false;             // BLE link up
static bool    gBleAdvertising     = false;             // BLE advertisement active
static volatile bool  gPendingRestart = false;           // set by RESET/DISCARD, consumed in loop()

// ── WebSocket state ───────────────────────────────────────────────
static bool    gWsConnected       = false;              // WS link up
static unsigned long gWsConnectStart = 0;                // millis() when gWs.begin() was called

// ── Handles ───────────────────────────────────────────────────────
static NimBLECharacteristic* pTxChar  = nullptr;        // BLE notify characteristic
static WebSocketsClient      gWs;                        // WS client instance
static Preferences            prefs;                      // NVS (preferences) handle

// ── Throttle timestamps ───────────────────────────────────────────
static unsigned long gLastServerMsg  = 0;                // last HEARTBEAT from server
static unsigned long gLastRegister   = 0;                // last REGISTER sent

// ── Forward declarations ────────────────────────────────────────────
static void startBLEAdvertising();
static void bleNotify(const char* msg);
static void updateStatusFlags();
static void wifiConnect(const char* ssid, const char* pass);
static void wsToUart(const char* payload, size_t len);

// ══════════════════════════════════════════════════════════════════════
//  BLE Callbacks
// ══════════════════════════════════════════════════════════════════════

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

class RxCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pc, NimBLEConnInfo&) override {
    std::string val = pc->getValue();
    Serial.printf("[BLE_RX] %s\n", val.c_str());
    const char* d = val.c_str();

    // ── Action (RESET / DISCARD) ────────────────────────────────────
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

    // ── Config (ssid / password / serverUrl / uniqueId) ─────────────
    char ssid[64]  = {0};
    char pass[64]  = {0};
    char url[128]  = {0};
    char uid[32]   = {0};

    #define EXTRACT(tag, buf, off) do {                              \
      const char* _f = strstr(d, "\"" tag "\":\"");                 \
      if (_f) {                                                      \
        const char* _s = _f + off;                                   \
        const char* _e = strchr(_s, '"');                            \
        if (_e && (size_t)(_e - _s) < sizeof(buf)) {                 \
          memcpy((void*)buf, _s, _e - _s);                           \
          buf[_e - _s] = '\0';                                       \
        }                                                             \
      }                                                               \
    } while(0)

    EXTRACT("ssid",      ssid,  8);
    EXTRACT("password",  pass, 12);
    EXTRACT("serverUrl", url,  13);
    EXTRACT("uniqueId",  uid,  12);

    #undef EXTRACT

    if (ssid[0] && pass[0] && url[0]) {
      // ── Log received config ───────────────────────────────────────
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

      // ── Persist to NVS ────────────────────────────────────────────
      prefs.begin("nexio", false);
      prefs.putString("ssid", ssid);
      prefs.putString("pass", pass);
      prefs.putString("url",  url);
      prefs.putString("uid",  gUniqueId);
      prefs.end();

      // ── Parse server URL → host + port ────────────────────────────
      int pp  = 0;
      int ps  = strstr(url, "://") ? (strstr(url, "://") - (char*)url + 3) : 0;
      char* lastColon = strrchr(url, ':');
      if (lastColon) pp = lastColon - url + 1;

      if (ps > 0 && pp > ps) {
        strncpy(gServerHost, url + ps, sizeof(gServerHost) - 1);

        // Strip port from host
        char* colon = strrchr(gServerHost, ':');
        if (colon) *colon = '\0';

        // Strip trailing slash from host
        char* slash = strchr(gServerHost, '/');
        if (slash) *slash = '\0';

        gServerPort = atoi(url + pp);
      }

      gOnboarded = true;
      updateStatusFlags();

      // Skip WiFi connect if already connected to the same SSID
      if (WiFi.status() != WL_CONNECTED || strcmp(WiFi.SSID().c_str(), ssid) != 0)
        wifiConnect(ssid, pass);
    }
  }
};

static SvrCb _svrCb;
static RxCb  _rxCb;

// ══════════════════════════════════════════════════════════════════════
//  BLE Helpers
// ══════════════════════════════════════════════════════════════════════

static void bleNotify(const char* msg) {
  // Send via BLE notification (when connected)
  if (gBleConnected && pTxChar) {
    pTxChar->setValue(msg);
    pTxChar->notify();
  }
  // Always print to USB-CDC serial
  Serial.println(msg);
}

static void startBLEAdvertising() {
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->stop();

  char name[48];
  if (gUniqueId[0])
    snprintf(name, sizeof(name), "Nexio-%s", gUniqueId);
  else
    strncpy(name, "Nexio", sizeof(name) - 1);
  NimBLEDevice::setDeviceName(name);

  // Manufacturer data: company ID (0x02D5) + status flags
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

// ── Status flag bits (exposed in BLE manufacturer data) ────────────
//   Bit 1 (0x02) = SVR  — registered with server
//   Bit 2 (0x04) = WIFI — Wi-Fi connected
//   Bit 3 (0x08) = CFG  — onboarded (has config)
static void updateStatusFlags() {
  uint8_t f = 0;
  if (gRegistered)     f |= 0x02;
  if (gWifiConnected)  f |= 0x04;
  if (gOnboarded)      f |= 0x08;
  if (f != gStatusFlags) {
    gStatusFlags = f;
    // Refresh BLE advertisement data so scanners see the new state
    if (gBleAdvertising) startBLEAdvertising();
  }
}

// ══════════════════════════════════════════════════════════════════════
//  Wi-Fi
// ══════════════════════════════════════════════════════════════════════

static void wifiConnect(const char* ssid, const char* pass) {
  char buf[128];
  snprintf(buf, sizeof(buf), "[WIFI] Connecting to %s...", ssid);
  bleNotify(buf);
  WiFi.disconnect(true);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);
  gWifiAttempted  = true;
  gWifiAttemptTime = millis();
}

// ══════════════════════════════════════════════════════════════════════
//  WebSocket
// ══════════════════════════════════════════════════════════════════════

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

static void sendHeartbeat() {
  char out[256];
  int len = snprintf(out, sizeof(out),
    "{\"type\":\"HEARTBEAT\",\"version\":\"1.0\",\"timestamp\":%lu", millis());
  if (gUniqueId[0])
    len += snprintf(out + len, sizeof(out) - len, ",\"id\":\"%s\"", gUniqueId);
  snprintf(out + len, sizeof(out) - len, "}");
  gWs.sendTXT(out);
}

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

      // ── ASSIGN_ID: server confirms registration ──────────────────
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

      // ── HEARTBEAT: server alive signal ───────────────────────────
      } else if (strcmp(type, "HEARTBEAT") == 0) {
        gLastServerMsg = millis();

      // ── CONTROL: action from server ──────────────────────────────
      } else if (strcmp(type, "CONTROL") == 0) {
        const char* action = doc["action"];
        if (!action) return;
        if (strcmp(action, "RESET") == 0) {
          gPendingRestart = true;
        } else if (strcmp(action, "DISCARD") == 0) {
          // Ack before restart so server knows we received it
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

      // ── DATA_RELAY: forward to product via UART ──────────────────
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

// ══════════════════════════════════════════════════════════════════════
//  UART ↔ WebSocket Relay
// ══════════════════════════════════════════════════════════════════════

// Read product UART bytes into a ring buffer, then flush them to the
// server as DATA_RELAY messages (hex-encoded) when WS is connected.
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

  // Number of bytes available (cap at 240 to keep WS frames small)
  size_t avail = (uartHead >= uartTail)
                   ? (uartHead - uartTail)
                   : (UART_BUF_SIZE - uartTail);
  if (avail > 240) avail = 240;

  // Hex-encode
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

// Decode a hex-encoded DATA_RELAY payload and write to product UART.
static void wsToUart(const char* payload, size_t len) {
  for (size_t i = 0; i + 1 < len; i += 2) {
    char h[3] = { payload[i], payload[i + 1], '\0' };
    char* end  = nullptr;
    uint8_t b  = strtoul(h, &end, 16);
    if (*end == '\0') Serial1.write(b);
  }
  Serial1.flush();
}

// ══════════════════════════════════════════════════════════════════════
//  Setup
// ══════════════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  Serial1.begin(PRODUCT_UART_BAUD, SERIAL_8N1, PRODUCT_UART_RX, PRODUCT_UART_TX);
  pinMode(LED_PIN, OUTPUT);

  // ── Restore persisted config ──────────────────────────────────────
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

  // ── Initialise BLE ────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════
//  Main Loop
// ══════════════════════════════════════════════════════════════════════

void loop() {
  // ── Pending restart (from RESET / DISCARD) ────────────────────────
  if (gPendingRestart) {
    gPendingRestart = false;
    delay(100);
    ESP.restart();
  }

  // ── WebSocket housekeeping ────────────────────────────────────────
  gWs.loop();

  // ── UART → WS relay ───────────────────────────────────────────────
  uartToWs();

  // ── Wi-Fi state transitions ───────────────────────────────────────

  // Connected (edge trigger)
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

  // Disconnected (edge trigger)
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

  // ── Wi-Fi timeout / retry ─────────────────────────────────────────
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

  // ── WebSocket reconnect watchdog ──────────────────────────────────
  // Triggers only when Wi-Fi is up but WS has stayed disconnected > 5 s
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

  // ── Send REGISTER (retry every 3 s until acknowledged) ────────────
  if (gWifiConnected && gWsConnected && !gRegistered && gServerHost[0] &&
      millis() - gLastRegister > 3000) {
    gLastRegister = millis();
    sendRegister();
  }

  // ── Send HEARTBEAT (every 5 s; server timeout is 9 s) ─────────────
  if (gWifiConnected && gRegistered &&
      millis() - gLastServerMsg > 5000) {
    gLastServerMsg = millis();
    sendHeartbeat();
  }

  // ── LED indicator ─────────────────────────────────────────────────
  digitalWrite(LED_PIN, WiFi.status() == WL_CONNECTED ? HIGH : LOW);

  delay(100);
}
