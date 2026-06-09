#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <esp_reset_reason.h>

RTC_DATA_ATTR int bootCount = 0;
RTC_DATA_ATTR int lastResetReason = 0;

#include "src/config.h"
#include "src/base64.hpp"
#include "src/wifi.hpp"
#include "src/ble.hpp"
#include "src/uart.hpp"
#include "src/http_board.hpp"
#include "src/ws_board.hpp"


String uniqueId = "";
String currentSsid = "";
String serverHost = "";
uint16_t serverPort = 0;
bool wifiConnected = false;
bool productConnected = false;
bool onboarded = false;
bool registered = false;

unsigned long lastServerMessage = 0;
unsigned long lastRegisterAttempt = 0;

unsigned long lastLedToggle = 0;
bool ledState = false;

bool rfidConnected = false;
bool lastProductConnected = false;

// Heap monitoring
static unsigned long lastHeapLog = 0;
static int heapLowWatermark = INT_MAX;

BoardWebSocket ws;
String wsLastMessage = "";
bool wsMessageReceived = false;

void updateStatusFlags();
void processWsMessage(const String& msg);

void onWsMessage(const String& msg) {
  wsLastMessage = msg;
  wsMessageReceived = true;
}

void onWsConnected() {
  Serial.println("[WS] Connected to server");
  bleLog("[WS] Connected");
  registered = false;
  lastRegisterAttempt = 0;
}

void onWsDisconnected() {
  Serial.println("[WS] Disconnected");
  bleLog("[WS] Disconnected");
}

static const char* resetReasonStr(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_UNKNOWN:    return "UNKNOWN";
    case ESP_RST_POWERON:    return "POWERON";
    case ESP_RST_EXT:        return "EXT_PIN";
    case ESP_RST_SW:         return "SOFTWARE (ESP.restart)";
    case ESP_RST_PANIC:      return "PANIC/CRASH";
    case ESP_RST_INT_WDT:    return "INTERRUPT_WDT";
    case ESP_RST_TASK_WDT:   return "TASK_WDT";
    case ESP_RST_WDT:        return "OTHER_WDT";
    case ESP_RST_DEEPSLEEP:  return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:   return "BROWNOUT";
    case ESP_RST_SDIO:       return "SDIO";
    default:                 return "???";
  }
}

static void printHeap(const char* label) {
  Serial.print(label);
  Serial.print(" free=");
  Serial.print(ESP.getFreeHeap());
  Serial.print(" maxBlock=");
  Serial.println(ESP.getMaxAllocHeap());
  Serial.flush();
}

void setup() {
  bootCount++;
  esp_reset_reason_t reason = esp_reset_reason();
  if (reason == ESP_RST_PANIC || reason == ESP_RST_TASK_WDT) {
    lastResetReason = reason;
  }

  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("=======================================");
  Serial.println("[BOOT] Nexio firmware starting...");
  Serial.println("=======================================");
  Serial.print("[BOOT] bootCount=");
  Serial.print(bootCount);
  Serial.print(" reason=");
  Serial.print(resetReasonStr(reason));
  if (lastResetReason > 0) {
    Serial.print(" lastCrash=");
    Serial.print(resetReasonStr((esp_reset_reason_t)lastResetReason));
  }
  Serial.println();

  if (reason == ESP_RST_BROWNOUT) {
    Serial.println("[BOOT] *** BROWNOUT detected! Check USB power supply. ***");
  }
  if (reason == ESP_RST_PANIC || reason == ESP_RST_TASK_WDT) {
    Serial.println("[BOOT] *** Previous crash/WDT detected! Likely memory or stack issue. ***");
  }
  if (reason == ESP_RST_POWERON || reason == ESP_RST_EXT) {
    bootCount = 1;
  }
  if (bootCount >= 3) {
    Serial.print("[BOOT] *** Boot loop detected (count=");
    Serial.print(bootCount);
    Serial.println("). Delaying 30s for debug...");
    for (int i = 30; i > 0; i--) {
      Serial.print("[BOOT] "); Serial.println(i);
      delay(1000);
    }
  }

  Serial.print("[BOOT] Chip model: "); Serial.println(ESP.getChipModel());
  Serial.print("[BOOT] CPU freq: "); Serial.print(ESP.getCpuFreqMHz()); Serial.println(" MHz");
  Serial.print("[BOOT] Flash size: "); Serial.print(ESP.getFlashChipSize() / 1024); Serial.println(" KB");
  printHeap("[BOOT] Heap at start");

  esp_brownout_disable();

  // LED init (must happen after Serial for flash-pin safety check)
  if (!IS_FLASH_PIN(STATUS_LED_PIN)) {
    pinMode(STATUS_LED_PIN, OUTPUT);
    for (int i = 0; i < 20; i++) {
      digitalWrite(STATUS_LED_PIN, (i % 2) ? HIGH : LOW);
      delay(100);
    }
    digitalWrite(STATUS_LED_PIN, LOW);
  } else {
    Serial.println("[BOOT] STATUS_LED_PIN on flash pin; skipping LED init");
  }

  unsigned long t0 = millis();
  initBLE();
  unsigned long t1 = millis();
  Serial.print("[BOOT] initBLE took "); Serial.print(t1 - t0); Serial.println(" ms");
  printHeap("[BOOT] After initBLE");

  if (loadConfig()) {
    bleLog("[BOOT] Config loaded");
    uniqueId = getUniqueId();
    setBleUniqueId(uniqueId);
    onboarded = true;
    initUART();
    printHeap("[BOOT] After initUART");

    String serverUrl = getServerUrl();
    int protocolStart = serverUrl.indexOf("://");
    int portStart = serverUrl.lastIndexOf(":");
    serverHost = serverUrl.substring(protocolStart + 3, portStart);
    serverPort = serverUrl.substring(portStart + 1).toInt();

    ws.begin(serverHost, serverPort);
    printHeap("[BOOT] After ws.begin");
    ws.onMessage(onWsMessage);
    ws.onConnected(onWsConnected);
    ws.onDisconnected(onWsDisconnected);

    connectWiFi();
  } else {
    bleStatusFlags = 0;
  }

  Serial.println("[BOOT] Starting BLE advertising...");
  startBLEAdvertising();
  Serial.println("[BOOT] BLE advertising started (ok)");
  printHeap("[BOOT] End of setup");
}

void sendDiscardAck() {
  StaticJsonDocument<128> ackDoc;
  ackDoc["type"] = "DISCARD_ACK";
  ackDoc["version"] = MESSAGE_VERSION;
  ackDoc["timestamp"] = millis();
  if (uniqueId.length() > 0) ackDoc["id"] = uniqueId;
  char output[256];
  serializeJson(ackDoc, output, sizeof(output));
  if (!ws.isConnected() || !ws.send(output, strlen(output))) {
    BoardResponse ackResp;
    httpBoardMessage(serverHost, serverPort, String(output), ackResp);
  }
}

void processWsMessage(const String& msg) {
  StaticJsonDocument<768> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) return;

  const char* type = doc["type"];

  if (strcmp(type, "ASSIGN_ID") == 0) {
    const char* newId = doc["uniqueId"];
    if (strlen(newId) > 0 && strcmp(newId, uniqueId.c_str()) != 0) {
      uniqueId = newId;
      setBleUniqueId(uniqueId);
      updateStatusFlags();
    }
    if (!registered) {
      registered = true;
      bleLog("[SVR] Registered");
    }
  } else if (strcmp(type, "HEARTBEAT") == 0) {
    lastServerMessage = millis();
  } else if (strcmp(type, "CONTROL") == 0) {
    const char* action = doc["action"];
    if (strcmp(action, "RESET") == 0) {
      ESP.restart();
    } else if (strcmp(action, "DISCARD") == 0) {
      sendDiscardAck();
      delay(100);
      clearConfig();
      delay(100);
      ESP.restart();
    } else if (strcmp(action, "DISCONNECT") == 0) {
    }
  } else if (strcmp(type, "DATA_RELAY") == 0) {
    const char* payload = doc["payload"];
    std::vector<uint8_t> binaryData = base64_decode(std::string(payload));
    Serial1.write(binaryData.data(), binaryData.size());
  } else if (strcmp(type, "BOARD_READY") == 0) {
  }
}

void loop() {
  int freeHeap = ESP.getFreeHeap();
  if (freeHeap < heapLowWatermark) {
    heapLowWatermark = freeHeap;
  }
  if (freeHeap < 50000 && millis() - lastHeapLog > 30000) {
    lastHeapLog = millis();
    Serial.print("[HEAP_WARN] free=");
    Serial.print(freeHeap);
    Serial.print(" low=");
    Serial.print(heapLowWatermark);
    Serial.print(" maxBlock=");
    Serial.println(ESP.getMaxAllocHeap());
    Serial.flush();
  }

  handleBLE();
  handleUART();

  bool wifiState = WiFi.status() == WL_CONNECTED;

  if (wifiState && !wifiConnected) {
    wifiConnected = true;
    currentSsid = WiFi.SSID();
    delay(1000);
    registered = false;
    lastServerMessage = 0;
    if (serverHost.length() > 0) {
      ws.begin(serverHost, serverPort);
      ws.onMessage(onWsMessage);
      ws.onConnected(onWsConnected);
      ws.onDisconnected(onWsDisconnected);
    }
  } else if (!wifiState && wifiConnected) {
    wifiConnected = false;
    productConnected = false;
    registered = false;
    ws.disconnect();
    reconnectWiFi();
  }

  ws.loop();

  if (wsMessageReceived) {
    wsMessageReceived = false;
    processWsMessage(wsLastMessage);
  }

  if (wifiConnected && !registered && serverHost.length() > 0 && millis() - lastRegisterAttempt > 3000) {
    lastRegisterAttempt = millis();

    char boardId[18];
    strncpy(boardId, WiFi.macAddress().c_str(), sizeof(boardId) - 1);
    boardId[sizeof(boardId) - 1] = '\0';
    unsigned long ts = millis();

    static char output[512];
    int pos = snprintf(output, sizeof(output),
      "{\"type\":\"REGISTER\",\"version\":\"%s\",\"timestamp\":%lu,\"boardId\":\"%s\","
      "\"firmwareVersion\":\"1.0.0\",\"displayAvailable\":false,\"productConnected\":%s",
      MESSAGE_VERSION, ts, boardId,
      productConnected ? "true" : "false");
    if (uniqueId.length() > 0) {
      pos += snprintf(output + pos, sizeof(output) - pos, ",\"uniqueId\":\"%s\"", uniqueId.c_str());
    }
    pos += snprintf(output + pos, sizeof(output) - pos, "}");

    if (ws.isConnected() && ws.send(output, strlen(output))) {
      // sent via WS
    } else {
      BoardResponse resp;
      if (httpBoardMessage(serverHost, serverPort, String(output), resp)) {
        if (resp.hasAssignId && resp.uniqueId.length() > 0) {
          uniqueId = resp.uniqueId;
          setBleUniqueId(uniqueId);
          updateStatusFlags();
          bleLog("[SVR] Registered as " + uniqueId);
        }
        registered = true;
      } else {
        bleLog("[SVR] Register FAILED, retrying...");
      }
    }
  }

  if (wifiConnected && registered) {
    if (millis() - lastServerMessage > HEARTBEAT_INTERVAL) {
      lastServerMessage = millis();

      char output[256];
      snprintf(output, sizeof(output),
        "{\"type\":\"HEARTBEAT\",\"version\":\"%s\",\"timestamp\":%lu",
        MESSAGE_VERSION, millis());
      if (uniqueId.length() > 0) {
        int len = strlen(output);
        snprintf(output + len, sizeof(output) - len, ",\"id\":\"%s\"", uniqueId.c_str());
      }
      int len = strlen(output);
      snprintf(output + len, sizeof(output) - len, "}");

      if (ws.isConnected() && ws.send(output, strlen(output))) {
        // sent via WS
      } else {
        BoardResponse resp;
        if (httpBoardMessage(serverHost, serverPort, String(output), resp)) {
          if (resp.hasControl) {
            if (resp.action == "RESET") {
              ESP.restart();
            } else if (resp.action == "DISCARD") {
              sendDiscardAck();
              clearConfig();
              ESP.restart();
            }
          }
          if (resp.hasDataRelay) {
            std::vector<uint8_t> binaryData = base64_decode(std::string(resp.payload.c_str()));
            Serial1.write(binaryData.data(), binaryData.size());
          }
        }
      }
    }
  }

  productConnected = isProductConnected();
  if (productConnected && registered && uniqueId.length() > 0) {
    sendProductProbe();
  }
  if (productConnected != lastProductConnected) {
    lastProductConnected = productConnected;
  }

  updateStatusFlags();
  // updateStatusLED uses the STATUS_LED_PIN; skip if it overlaps flash pins
  if (!IS_FLASH_PIN(STATUS_LED_PIN)) updateStatusLED();

  if (blePendingAction.length() > 0) {
    String action = blePendingAction;
    blePendingAction = "";
    if (action == "DISCARD") {
      clearConfig();
      delay(100);
      ESP.restart();
    } else if (action == "RESET") {
      delay(100);
      ESP.restart();
    }
  }

  if (!isBleConnected() && !isBleAdvertising()) {
    startBLEAdvertising();
  }
}

void updateStatusFlags() {
  uint8_t flags = 0;
  if (productConnected) flags |= STATUS_FLAG_PRD;
  if (registered)       flags |= STATUS_FLAG_SVR;
  if (wifiConnected)    flags |= STATUS_FLAG_WIFI;
  if (onboarded)        flags |= STATUS_FLAG_CFG;
  setBleStatus(flags);
}

void updateStatusLED() {
  unsigned long interval;
  if (productConnected) {
    if (!IS_FLASH_PIN(STATUS_LED_PIN)) digitalWrite(STATUS_LED_PIN, LOW);
    return;
  } else if (registered) {
    interval = 1000;
  } else {
    interval = 200;
  }
  unsigned long now = millis();
  if (now - lastLedToggle >= interval) {
    lastLedToggle = now;
    ledState = !ledState;
    if (!IS_FLASH_PIN(STATUS_LED_PIN)) digitalWrite(STATUS_LED_PIN, ledState ? HIGH : LOW);
  }
}

void connectWiFi() {
  String ssid = getWifiSsid();
  String pass = getWifiPass();

  if (ssid.length() > 0) {
    WiFi.disconnect(true);
    delay(100);
    WiFi.mode(WIFI_STA);
    delay(100);
    Serial.print("[WIFI] Connecting to "); Serial.println(ssid);
    WiFi.begin(ssid.c_str(), pass.c_str());
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
      delay(500);
      attempts++;
      Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
      delay(500);
    } else {
      if (WiFi.status() == WL_NO_SSID_AVAIL) { bleLog("[WIFI] Network not found"); }
      else if (WiFi.status() == WL_CONNECT_FAILED) { bleLog("[WIFI] Wrong password"); }
      else { bleLog("[WIFI] Connection timeout"); }
    }
  }
}

void reconnectWiFi() {
  delay(WIFI_RECONNECT_INTERVAL);
  String ssid = getWifiSsid();
  String pass = getWifiPass();
  WiFi.begin(ssid.c_str(), pass.c_str());
}

void sendDataToServer(const uint8_t* data, size_t len) {
  if (!registered || uniqueId.length() == 0 || serverHost.length() == 0) return;

  std::string b64 = base64_encode(data, len);

  static char output[1024];
  snprintf(output, sizeof(output),
    "{\"type\":\"DATA_RELAY\",\"version\":\"%s\",\"timestamp\":%lu,"
    "\"sessionId\":\"\",\"sourceId\":\"%s\",\"direction\":\"B_TO_C\","
    "\"payload\":\"%s\"}",
    MESSAGE_VERSION, millis(), uniqueId.c_str(), b64.c_str());

  if (!ws.isConnected() || !ws.send(output, strlen(output))) {
    BoardResponse resp;
    httpBoardMessage(serverHost, serverPort, String(output), resp);
  }
  lastServerMessage = millis();
}

void sendLog(const String& level, const String& message) {
  if (!registered || uniqueId.length() == 0 || serverHost.length() == 0) return;

  static char output[512];
  snprintf(output, sizeof(output),
    "{\"type\":\"LOG\",\"version\":\"%s\",\"timestamp\":%lu,\"id\":\"%s\",\"level\":\"%s\",\"message\":\"%s\"}",
    MESSAGE_VERSION, millis(), uniqueId.c_str(), level.c_str(), message.c_str());

  if (!ws.isConnected() || !ws.send(output, strlen(output))) {
    BoardResponse resp;
    httpBoardMessage(serverHost, serverPort, String(output), resp);
  }
  lastServerMessage = millis();
}

void logDebug(const String& prefix, const String& message) {
  Serial.print(prefix); Serial.println(message);
}

void onWiFiConfigured(const String& ssid, const String& pass, const String& url, const String& boardUniqueId) {
  Serial.println("[CFG] WiFi config received via BLE");
  Serial.print("[CFG] SSID: "); Serial.println(ssid);
  Serial.print("[CFG] Server: "); Serial.println(url);
  bleLog("[CFG] Config received: " + ssid);
  if (boardUniqueId.length() > 0) {
    uniqueId = boardUniqueId;
    setBleUniqueId(uniqueId);
    Serial.print("[CFG] Board ID: "); Serial.println(uniqueId);
  }

  int protocolStart = url.indexOf("://");
  int portStart = url.lastIndexOf(":");
  serverHost = url.substring(protocolStart + 3, portStart);
  serverPort = url.substring(portStart + 1).toInt();

  onboarded = true;
  saveConfig(ssid, pass, url, uniqueId);
  Serial.println("[CFG] Config saved, connecting WiFi...");
  connectWiFi();
}
