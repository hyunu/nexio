#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>

#include "src/config.h"
#include "src/base64.hpp"
#include "src/ble.hpp"
#include "src/wifi.hpp"
#include "src/uart.hpp"
#include "src/http_board.hpp"


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

void updateStatusFlags();

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println();
  Serial.println("[BOOT] Nexio firmware starting...");

  if (loadConfig()) {
    uniqueId = getUniqueId();
    setBleUniqueId(uniqueId);
    onboarded = true;
    initUART();
    Serial.println("[BOOT] Config loaded, connecting WiFi...");

    String serverUrl = getServerUrl();
    int protocolStart = serverUrl.indexOf("://");
    int portStart = serverUrl.lastIndexOf(":");
    serverHost = serverUrl.substring(protocolStart + 3, portStart);
    serverPort = serverUrl.substring(portStart + 1).toInt();

    connectWiFi();
  } else {
    initBLE();
    bleStatusFlags = 0;
    Serial.println("[BOOT] No config, starting BLE advertising...");
    startBLEAdvertising();
  }
}

void loop() {
  handleBLE();
  handleUART();

  bool wifiState = WiFi.status() == WL_CONNECTED;

  if (wifiState && !wifiConnected) {
    wifiConnected = true;
    currentSsid = WiFi.SSID();
    Serial.print("[LOOP] WiFi connected to "); Serial.println(currentSsid);
    delay(1000);
    registered = false;
    lastServerMessage = 0;
  } else if (!wifiState && wifiConnected) {
    wifiConnected = false;
    productConnected = false;
    registered = false;
    Serial.println("[LOOP] WiFi disconnected, reconnecting...");
    reconnectWiFi();
  }

  if (wifiConnected && !registered && serverHost.length() > 0 && millis() - lastRegisterAttempt > 3000) {
    lastRegisterAttempt = millis();
    JsonDocument doc;
    doc["type"] = "REGISTER";
    doc["version"] = MESSAGE_VERSION;
    doc["timestamp"] = millis();
    doc["boardId"] = WiFi.macAddress();
    doc["firmwareVersion"] = "1.0.0";
    doc["displayAvailable"] = false;
    if (uniqueId.length() > 0) doc["uniqueId"] = uniqueId;

    String output;
    serializeJson(doc, output);

    Serial.print("[HTTP] Sending REGISTER...");
    BoardResponse resp;
    if (httpBoardMessage(serverHost, serverPort, output, resp)) {
      Serial.println(" OK");
      if (resp.hasAssignId && resp.uniqueId.length() > 0) {
        Serial.print("[HTTP] ASSIGN_ID: "); Serial.println(resp.uniqueId);
        uniqueId = resp.uniqueId;
        setBleUniqueId(uniqueId);
        updateStatusFlags();
      }
      registered = true;
    } else {
      Serial.println(" FAILED");
    }
  }

  if (wifiConnected && registered) {
    if (millis() - lastServerMessage > HEARTBEAT_INTERVAL) {
      lastServerMessage = millis();

      JsonDocument doc;
      doc["type"] = "HEARTBEAT";
      doc["version"] = MESSAGE_VERSION;
      doc["timestamp"] = millis();
      if (uniqueId.length() > 0) doc["id"] = uniqueId;

      String output;
      serializeJson(doc, output);

      BoardResponse resp;
      if (httpBoardMessage(serverHost, serverPort, output, resp)) {
        if (resp.hasControl) {
          Serial.print("[HTTP] CONTROL: "); Serial.println(resp.action);
          if (resp.action == "RESET") {
            ESP.restart();
          } else if (resp.action == "FACTORY_RESET") {
            clearConfig();
            ESP.restart();
          } else if (resp.action == "DISCARD") {
            Serial.println("[HTTP] DISCARD received, sending ACK...");
            JsonDocument ackDoc;
            ackDoc["type"] = "DISCARD_ACK";
            ackDoc["version"] = MESSAGE_VERSION;
            ackDoc["timestamp"] = millis();
            if (uniqueId.length() > 0) ackDoc["id"] = uniqueId;
            String ackOutput;
            serializeJson(ackDoc, ackOutput);
            BoardResponse ackResp;
            httpBoardMessage(serverHost, serverPort, ackOutput, ackResp);
            clearConfig();
            ESP.restart();
          } else if (resp.action == "DISCONNECT") {
            Serial.println("[HTTP] Disconnecting...");
          }
        }
        if (resp.hasDataRelay) {
          String base64Data = resp.payload;
          std::vector<uint8_t> binaryData = base64_decode(std::string(base64Data.c_str()));
          Serial1.write(binaryData.data(), binaryData.size());
        }
      }
    }
  }

  productConnected = isProductConnected();
  if (productConnected && registered && uniqueId.length() > 0) {
    sendProductProbe();
  }

  updateStatusFlags();

  if (onboarded && wifiConnected && registered && !isBleAdvertising()) {
  } else if (onboarded && (!wifiConnected || !registered)) {
    if (!isBleAdvertising()) {
      if (pServer == nullptr) {
        bleStatusFlags = 0;
        initBLE();
        startBLEAdvertising();
      } else {
        resumeBLE();
      }
    }
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
      Serial.print("[WIFI] Connected, IP: ");
      Serial.println(WiFi.localIP());
      delay(500);
    } else {
      Serial.print("[WIFI] Failed, status=");
      Serial.println(WiFi.status());
      if (WiFi.status() == WL_NO_SSID_AVAIL) Serial.println("[WIFI] Network not found");
      else if (WiFi.status() == WL_CONNECT_FAILED) Serial.println("[WIFI] Wrong password");
    }
  }
}

void reconnectWiFi() {
  Serial.println("[WIFI] Reconnecting...");
  delay(WIFI_RECONNECT_INTERVAL);
  String ssid = getWifiSsid();
  String pass = getWifiPass();
  WiFi.begin(ssid.c_str(), pass.c_str());
}

void sendDataToServer(const uint8_t* data, size_t len) {
  if (!registered || uniqueId.length() == 0 || serverHost.length() == 0) return;

  String base64Data = base64_encode(data, len).c_str();

  JsonDocument doc;
  doc["type"] = "DATA_RELAY";
  doc["version"] = MESSAGE_VERSION;
  doc["timestamp"] = millis();
  doc["sessionId"] = "";
  doc["sourceId"] = uniqueId;
  doc["direction"] = "B_TO_C";
  doc["payload"] = base64Data;

  String output;
  serializeJson(doc, output);
  BoardResponse resp;
  httpBoardMessage(serverHost, serverPort, output, resp);
  lastServerMessage = millis();
}

void onWiFiConfigured(const String& ssid, const String& pass, const String& url, const String& boardUniqueId) {
  Serial.println("[CFG] WiFi config received via BLE");
  Serial.print("[CFG] SSID: "); Serial.println(ssid);
  Serial.print("[CFG] Server: "); Serial.println(url);
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
