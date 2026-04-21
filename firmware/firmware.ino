#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <TFT_eSPI.h>
#include "config.h"
#include "src/config.h"
#include "src/base64.cpp"
#include "src/ble.cpp"
#include "src/wifi.cpp"
#include "src/websocket.cpp"
#include "src/uart.cpp"
#include "src/display.cpp"

TFT_eSPI tft = TFT_eSPI();

String uniqueId = "";
String currentSsid = "";
bool wsConnected = false;
bool wifiConnected = false;

unsigned long lastHeartbeat = 0;

void setup() {
  Serial.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);

  initDisplay(tft);
  displayStatus("Initializing...");

  initBLE();

  if (loadConfig()) {
    displayStatus("Connecting WiFi...");
    connectWiFi();
  } else {
    displayStatus("BLE Waiting...\nConfigure via App");
    startBLEAdvertising();
  }
}

void loop() {
  handleBLE();

  if (WiFi.status() == WL_CONNECTED && !wifiConnected) {
    wifiConnected = true;
    currentSsid = WiFi.SSID();
    displayWiFiStatus(currentSsid, true);
    connectWebSocket();
  }

  if (WiFi.status() != WL_CONNECTED && wifiConnected) {
    wifiConnected = false;
    displayWiFiStatus(currentSsid, false);
    reconnectWiFi();
  }

  if (wsConnected) {
    webSocketClient.loop();

    if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL) {
      sendHeartbeat();
      lastHeartbeat = millis();
    }
  }

  handleUART();
}

void connectWiFi() {
  String ssid = getWifiSsid();
  String pass = getWifiPass();

  if (ssid.length() > 0) {
    WiFi.begin(ssid.c_str(), pass.c_str());
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
      delay(500);
      attempts++;
    }
  }
}

void reconnectWiFi() {
  delay(WIFI_RECONNECT_INTERVAL);
  String ssid = getWifiSsid();
  String pass = getWifiPass();
  WiFi.begin(ssid.c_str(), pass.c_str());
}

void connectWebSocket() {
  String serverUrl = getServerUrl();
  if (serverUrl.length() == 0) return;

  int protocolStart = serverUrl.indexOf("://");
  int portStart = serverUrl.lastIndexOf(":");
  String host = serverUrl.substring(protocolStart + 3, portStart);
  int port = serverUrl.substring(portStart + 1).toInt();
  String path = "/ws/board";

  webSocketClient.beginSSL(host.c_str(), port, path);
  webSocketClient.onEvent(webSocketEvent);
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      wsConnected = false;
      displayWsStatus(false);
      break;

    case WStype_CONNECTED:
      wsConnected = true;
      displayWsStatus(true);
      sendRegister();
      break;

    case WStype_TEXT:
      handleServerMessage((char*)payload);
      break;

    case WStype_ERROR:
      wsConnected = false;
      displayWsStatus(false);
      break;

    default:
      break;
  }
}

void handleServerMessage(char* payload) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, payload);

  if (error) return;

  String type = doc["type"].as<String>();

  if (type == "ASSIGN_ID") {
    uniqueId = doc["uniqueId"].as<String>();
    displayId(uniqueId);
  }

  if (type == "DATA_RELAY") {
    String direction = doc["direction"].as<String>();
    if (direction == "C_TO_B") {
      String base64Data = doc["payload"].as<String>();
      std::vector<uint8_t> binaryData = base64Decode(base64Data);
      Serial.write(binaryData.data(), binaryData.size());
    }
  }

  if (type == "CONTROL") {
    String action = doc["action"].as<String>();
    if (action == "RESET") {
      ESP.restart();
    }
  }
}

void sendRegister() {
  JsonDocument doc;
  doc["type"] = "REGISTER";
  doc["version"] = MESSAGE_VERSION;
  doc["timestamp"] = millis();
  doc["boardId"] = WiFi.macAddress();
  doc["firmwareVersion"] = "1.0.0";
  doc["displayAvailable"] = true;

  String output;
  serializeJson(doc, output);
  webSocketClient.sendTXT(output);
}

void sendHeartbeat() {
  JsonDocument doc;
  doc["type"] = "HEARTBEAT";
  doc["version"] = MESSAGE_VERSION;
  doc["timestamp"] = millis();
  doc["id"] = uniqueId;

  String output;
  serializeJson(doc, output);
  webSocketClient.sendTXT(output);
}

void sendDataToServer(const uint8_t* data, size_t len) {
  if (!wsConnected || uniqueId.length() == 0) return;

  String base64Data = base64Encode(data, len);

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
  webSocketClient.sendTXT(output);
}

void onWiFiConfigured(const String& ssid, const String& pass, const String& url) {
  saveConfig(ssid, pass, url);
  displayStatus("WiFi Configured\nConnecting...");
  connectWiFi();
}
