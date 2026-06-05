#include <WiFi.h>
#include <ArduinoJson.h>
#include "config.h"

struct BoardResponse {
  String uniqueId;
  String action;
  String reason;
  String payload;
  String sessionId;
  String direction;
  bool hasAssignId = false;
  bool hasControl = false;
  bool hasDataRelay = false;
};

static bool httpBoardMessage(const String& host, uint16_t port, const String& json, BoardResponse& resp) {
  WiFiClient client;
  IPAddress serverIP;
  if (!serverIP.fromString(host)) return false;
  if (!client.connect(serverIP, port, 5000)) return false;
  client.setNoDelay(true);

  String body = json;
  String req = "POST /api/board/message HTTP/1.1\r\n"
    "Host: " + host + ":" + port + "\r\n"
    "Content-Type: application/json\r\n"
    "Content-Length: " + body.length() + "\r\n"
    "Connection: close\r\n\r\n"
    + body;

  client.print(req);
  client.flush();

  unsigned long timeout = millis() + 5000;
  String httpResponse;
  while (millis() < timeout) {
    while (client.available()) {
      char c = client.read();
      httpResponse += c;
      if (httpResponse.endsWith("\r\n\r\n")) { timeout = 0; break; }
    }
    if (timeout == 0) break;
  }
  bool timedOut = (timeout > 0);
  if (timedOut) { client.stop(); return false; }

  int bodyStart = httpResponse.indexOf("\r\n\r\n");
  if (bodyStart < 0) { client.stop(); return false; }

  String headerLine = httpResponse.substring(0, bodyStart);
  if (headerLine.indexOf("200") < 0 && headerLine.indexOf("201") < 0) {
    client.stop(); return false;
  }

  int contentLen = 0;
  String hdrLower = headerLine;
  hdrLower.toLowerCase();
  int clIdx = hdrLower.indexOf("content-length:");
  if (clIdx >= 0) {
    int clEnd = headerLine.indexOf('\r', clIdx);
    String val = headerLine.substring(clIdx + 15, clEnd);
    val.trim();
    contentLen = val.toInt();
  }

  String bodyStr;
  unsigned long bt = millis() + 3000;
  if (contentLen > 0) {
    while ((int)bodyStr.length() < contentLen && millis() < bt) {
      while (client.available() && (int)bodyStr.length() < contentLen) {
        char c = client.read();
        bodyStr += c;
      }
    }
  } else {
    while (client.connected() && millis() < bt) {
      while (client.available()) {
        char c = client.read();
        bodyStr += c;
      }
    }
  }
  client.stop();

  if (bodyStr.length() == 0) return true;

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, bodyStr);
  if (err) return true;

  if (doc["uniqueId"].is<String>()) {
    resp.hasAssignId = true;
    resp.uniqueId = doc["uniqueId"].as<String>();
  }

  if (doc["commands"].is<JsonArray>()) {
    JsonArray cmds = doc["commands"].as<JsonArray>();
    for (JsonVariant cmd : cmds) {
      String cmdType = cmd["type"].as<String>();
      if (cmdType == "ASSIGN_ID") {
        resp.hasAssignId = true;
        resp.uniqueId = cmd["uniqueId"].as<String>();
      } else if (cmdType == "CONTROL") {
        resp.hasControl = true;
        resp.action = cmd["action"].as<String>();
        resp.reason = cmd["reason"].as<String>();
      } else if (cmdType == "DATA_RELAY") {
        resp.hasDataRelay = true;
        resp.sessionId = cmd["sessionId"].as<String>();
        resp.direction = cmd["direction"].as<String>();
        resp.payload = cmd["payload"].as<String>();
      }
    }
  }

  return true;
}
