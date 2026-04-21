#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "config.h"

WebSocketsClient webSocketClient;

extern void webSocketEvent(WStype_t type, uint8_t* payload, size_t length);
extern void sendDataToServer(const uint8_t* data, size_t len);

void initWebSocket() {
}

void disconnectWebSocket() {
  webSocketClient.disconnect();
}

void reconnectWebSocket() {
  webSocketClient.disconnect();
  delay(WS_RECONNECT_INTERVAL);
}

bool isWsConnected() {
  return webSocketClient.isConnected();
}

void sendWsMessage(const String& msg) {
  webSocketClient.sendTXT(msg);
}
