#include <WiFi.h>
#include <ArduinoJson.h>
#include "config.h"

#define WS_OP_CONTINUE 0x0
#define WS_OP_TEXT     0x1
#define WS_OP_BINARY   0x2
#define WS_OP_CLOSE    0x8
#define WS_OP_PING     0x9
#define WS_OP_PONG     0xA

class BoardWebSocket {
public:
  BoardWebSocket() {}

  void begin(const String& host, uint16_t port) {
    _host = host;
    _port = port;
    if (_state == CONNECTED) {
      _resetConnection();
    }
    _state = IDLE;
    _reconnectTimer = 0;
  }

  void loop() {
    switch (_state) {
      case IDLE:
        if (_reconnectTimer > 0 && millis() < _reconnectTimer) break;
        _reconnectTimer = 0;
        _startConnect();
        break;

      case CONNECTING:
        if (!_client.connected()) {
          _client.stop();
          _scheduleReconnect();
          break;
        }
        if (_client.available()) {
          _checkHandshake();
        }
        break;

      case CONNECTED:
        if (!_client.connected()) {
          _resetConnection();
          break;
        }
        _readFrames();
        break;
    }
  }

  bool send(const String& text) {
    return send(text.c_str(), text.length());
  }

  bool send(const char* data, size_t len) {
    if (_state != CONNECTED) return false;
    if (!_client.connected()) {
      _resetConnection();
      return false;
    }
    return _sendFrame(WS_OP_TEXT, (const uint8_t*)data, len);
  }

  bool isConnected() {
    return _state == CONNECTED && _client.connected();
  }

  void disconnect() {
    if (_state == CONNECTED) {
      uint8_t closeFrame[2] = {0x03, 0xE8};
      _sendFrame(WS_OP_CLOSE, closeFrame, 2);
    }
    _resetConnection();
  }

  void onMessage(void (*cb)(const String&)) { _onMessage = cb; }
  void onConnected(void (*cb)())             { _onConnected = cb; }
  void onDisconnected(void (*cb)())          { _onDisconnected = cb; }

private:
  enum State { IDLE, CONNECTING, CONNECTED };

  WiFiClient _client;
  State _state = IDLE;
  String _host;
  uint16_t _port = 0;
  unsigned long _reconnectTimer = 0;

  void (*_onMessage)(const String&)      = nullptr;
  void (*_onConnected)()                 = nullptr;
  void (*_onDisconnected)()              = nullptr;

  uint8_t _rxBuf[2048];
  size_t  _rxLen = 0;
  uint8_t _txBuf[2048];

  void _startConnect() {
    _client.stop();
    IPAddress ip;
    if (!ip.fromString(_host)) {
      _scheduleReconnect();
      return;
    }
    _state = CONNECTING;
    if (!_client.connect(ip, _port, 5000)) {
      _client.stop();
      _scheduleReconnect();
      return;
    }
    _client.setNoDelay(true);
    String key = "dGhlIHNhbXBsZSBub25jZQ==";
    String req = "GET /ws/board HTTP/1.1\r\n"
      "Host: " + _host + ":" + _port + "\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Key: " + key + "\r\n"
      "Sec-WebSocket-Version: 13\r\n"
      "\r\n";
    _client.print(req);
    _client.flush();
  }

  void _checkHandshake() {
    unsigned long timeout = millis() + 3000;
    String resp;
    while (millis() < timeout) {
      while (_client.available()) {
        char c = _client.read();
        resp += c;
        if (resp.endsWith("\r\n\r\n")) {
          if (resp.indexOf("101") >= 0) {
            _rxLen = 0;
            _state = CONNECTED;
            if (_onConnected) _onConnected();
          } else {
            _client.stop();
            _scheduleReconnect();
          }
          return;
        }
      }
    }
    _client.stop();
    _scheduleReconnect();
  }

  void _readFrames() {
    while (_client.available() && _rxLen < sizeof(_rxBuf)) {
      _rxBuf[_rxLen++] = _client.read();
    }
    while (_rxLen >= 2) {
      uint8_t b1 = _rxBuf[0];
      uint8_t b2 = _rxBuf[1];
      uint8_t opcode = b1 & 0x0F;
      uint64_t payloadLen = b2 & 0x7F;
      bool masked = (b2 & 0x80) != 0;

      size_t headerLen = 2;
      size_t offset = 2;
      if (payloadLen == 126) {
        headerLen += 2;
        if (_rxLen < headerLen) break;
        payloadLen = ((uint16_t)_rxBuf[offset] << 8) | _rxBuf[offset + 1];
        offset += 2;
      } else if (payloadLen == 127) {
        headerLen += 8;
        if (_rxLen < headerLen) break;
        payloadLen = 0;
        for (int i = 0; i < 8; i++) {
          payloadLen = (payloadLen << 8) | _rxBuf[offset + i];
        }
        offset += 8;
      }

      uint8_t mask[4];
      if (masked) {
        headerLen += 4;
        if (_rxLen < headerLen) break;
        mask[0] = _rxBuf[offset++];
        mask[1] = _rxBuf[offset++];
        mask[2] = _rxBuf[offset++];
        mask[3] = _rxBuf[offset++];
      }

      size_t totalFrameLen = headerLen + payloadLen;
      if (_rxLen < totalFrameLen) break;

      char payload[1024];
      size_t plLen = payloadLen > 1023 ? 1023 : payloadLen;
      for (size_t i = 0; i < plLen; i++) {
        uint8_t byte = _rxBuf[headerLen + i];
        if (masked) byte ^= mask[i % 4];
        payload[i] = (char)byte;
      }
      payload[plLen] = '\0';

      size_t remaining = _rxLen - totalFrameLen;
      memmove(_rxBuf, _rxBuf + totalFrameLen, remaining);
      _rxLen = remaining;

      if (opcode == WS_OP_TEXT && _onMessage) {
        _onMessage(String(payload));
      } else if (opcode == WS_OP_CLOSE) {
        _resetConnection();
        return;
      } else if (opcode == WS_OP_PING) {
        _sendFrame(WS_OP_PONG, nullptr, 0);
      }
    }
  }

  bool _sendFrame(uint8_t opcode, const uint8_t* data, size_t len) {
    size_t pos = 0;
    _txBuf[pos++] = 0x80 | opcode;

    uint8_t mask[4] = { 0x12, 0x34, 0x56, 0x78 };

    if (len < 126) {
      _txBuf[pos++] = 0x80 | len;
    } else if (len < 65536) {
      _txBuf[pos++] = 0x80 | 126;
      _txBuf[pos++] = (len >> 8) & 0xFF;
      _txBuf[pos++] = len & 0xFF;
    } else {
      _txBuf[pos++] = 0x80 | 127;
      for (int i = 7; i >= 0; i--) {
        _txBuf[pos++] = (len >> (i * 8)) & 0xFF;
      }
    }

    _txBuf[pos++] = mask[0];
    _txBuf[pos++] = mask[1];
    _txBuf[pos++] = mask[2];
    _txBuf[pos++] = mask[3];

    for (size_t i = 0; i < len && pos < sizeof(_txBuf); i++) {
      _txBuf[pos++] = data[i] ^ mask[i % 4];
    }

    size_t wrote = _client.write(_txBuf, pos);
    _client.flush();
    return wrote == pos;
  }

  void _scheduleReconnect() {
    _client.stop();
    _state = IDLE;
    _reconnectTimer = millis() + WS_RECONNECT_INTERVAL;
    if (_onDisconnected) _onDisconnected();
  }

  void _resetConnection() {
    _client.stop();
    _rxLen = 0;
    _state = IDLE;
    _reconnectTimer = millis() + WS_RECONNECT_INTERVAL;
    if (_onDisconnected) _onDisconnected();
  }
};
