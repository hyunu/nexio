#include <WiFi.h>
#include "config.h"

enum WStype {
  WStype_DISCONNECTED,
  WStype_CONNECTED,
  WStype_TEXT,
  WStype_ERROR,
};

class NexioWebSocket {
public:
  void begin(const char* host, uint16_t port, const char* path) {
    _host = host;
    _port = port;
    _path = path;
    _state = WS_IDLE;
    _reconnectTimer = 0;
  }

  void onEvent(void (*callback)(WStype, uint8_t*, size_t)) {
    _callback = callback;
  }

  void loop() {
    if (_state == WS_IDLE && _reconnectTimer == 0) {
      _startConnect();
    }

    if (_state == WS_CONNECTING) {
      if (!_client.connected()) {
        _client.stop();
        _state = WS_IDLE;
        _reconnectTimer = millis() + 3000;
        _fireEvent(WStype_DISCONNECTED, nullptr, 0);
        return;
      }
      if (_client.available()) {
        String resp;
        unsigned long t = millis() + 2000;
        while (millis() < t) {
          while (_client.available()) {
            char c = _client.read();
            resp += c;
            if (resp.endsWith("\r\n\r\n")) { t = 0; break; }
          }
          if (t == 0) break;
        }
        if (resp.indexOf("101") > 0) {
          while (_client.available()) _client.read();
          delay(100);
          _client.setNoDelay(true);
          _state = WS_CONNECTED;
          _fireEvent(WStype_CONNECTED, nullptr, 0);
        } else {
          _client.stop();
          _state = WS_IDLE;
          _reconnectTimer = millis() + 3000;
          _fireEvent(WStype_ERROR, nullptr, 0);
          _fireEvent(WStype_DISCONNECTED, nullptr, 0);
        }
      }
      return;
    }

    if (_state == WS_CONNECTED) {
      if (!_client.connected()) {
        _client.stop();
        _state = WS_IDLE;
        _reconnectTimer = millis() + 3000;
        _fireEvent(WStype_DISCONNECTED, nullptr, 0);
        return;
      }
      while (_client.available() >= 2) {
        _readFrame();
      }
    }

    if (_state == WS_IDLE && _reconnectTimer > 0 && (int)(millis() - _reconnectTimer) >= 0) {
      _reconnectTimer = 0;
    }
  }

  void sendTXT(const String& msg) {
    if (_state != WS_CONNECTED) return;
    if (!_client.connected()) {
      Serial.println("[WS] sendTXT: client disconnected, resetting state");
      _client.stop();
      _state = WS_IDLE;
      _reconnectTimer = millis() + 3000;
      _fireEvent(WStype_DISCONNECTED, nullptr, 0);
      return;
    }
    Serial.print("[WS] sendTXT len="); Serial.println(msg.length());
    _sendFrame(0x1, (const uint8_t*)msg.c_str(), msg.length());
    _client.flush();
    Serial.println("[WS] sendTXT done");
  }

  bool isConnected() {
    return _state == WS_CONNECTED && _client.connected();
  }

  void disconnect() {
    if (_state == WS_CONNECTED) {
      uint8_t close[2] = {0x03, 0xE8};
      _sendFrame(0x8, close, 2);
    }
    _client.stop();
    _state = WS_IDLE;
  }

private:
  enum State { WS_IDLE, WS_CONNECTING, WS_CONNECTED };

  IPAddress _serverIP;
  String _host;
  uint16_t _port;
  String _path;
  State _state = WS_IDLE;
  WiFiClient _client;
  unsigned long _reconnectTimer = 0;
  void (*_callback)(WStype, uint8_t*, size_t) = nullptr;

  void _startConnect() {
    _client.stop();
    _serverIP.fromString(_host);
    if (!_client.connect(_serverIP, _port, 5000)) {
      _state = WS_IDLE;
      _reconnectTimer = millis() + 3000;
      return;
    }
    _client.setNoDelay(true);
    _state = WS_CONNECTING;
    delay(50);

    String key = "dGhlIHNhbXBsZSBub25jZQ==";
    String req = "GET " + _path + " HTTP/1.1\r\n"
      + "Host: " + _host + ":" + _port + "\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + "Sec-WebSocket-Key: " + key + "\r\n"
      + "Sec-WebSocket-Version: 13\r\n\r\n";
    _client.print(req);
    _client.flush();
    Serial.println("[WS] Handshake request sent");
  }

  void _sendFrame(uint8_t opcode, const uint8_t* data, size_t len) {
    // reduce frame buffer size to save RAM
    uint8_t frame[512];
    size_t pos = 0;

    frame[pos++] = 0x80 | opcode;

    uint8_t mask[4] = {0x12, 0x34, 0x56, 0x78};

    if (len < 126) {
      frame[pos++] = 0x80 | len;
    } else if (len < 65536) {
      frame[pos++] = 0x80 | 126;
      frame[pos++] = (len >> 8) & 0xFF;
      frame[pos++] = len & 0xFF;
    } else {
      frame[pos++] = 0x80 | 127;
      for (int i = 7; i >= 0; i--) {
        frame[pos++] = (len >> (i * 8)) & 0xFF;
      }
    }

    memcpy(frame + pos, mask, 4);
    pos += 4;

    for (size_t i = 0; i < len && pos + 1 <= sizeof(frame); i++) {
      frame[pos++] = data[i] ^ mask[i % 4];
    }

    size_t wrote = _client.write(frame, pos);
    _client.flush();
    Serial.print("[WS] Frame wrote="); Serial.print(wrote);
    Serial.print(" / "); Serial.println(pos);
  }

  void _readFrame() {
    if (_client.available() < 2) return;
    int b1 = _client.read();
    int b2 = _client.read();
    if (b1 < 0 || b2 < 0) return;

    uint8_t h1 = (uint8_t)b1;
    uint8_t h2 = (uint8_t)b2;
    uint8_t opcode = h1 & 0x0F;
    uint64_t len = h2 & 0x7F;

    Serial.print("[WS] RX frame: opcode="); Serial.print(opcode, HEX);
    Serial.print(" len="); Serial.println(len);

    if (len == 126) {
      if (_client.available() < 2) return;
      len = (uint16_t)_client.read() << 8;
      len |= (uint16_t)_client.read();
    } else if (len == 127) {
      len = 0;
      for (int i = 7; i >= 0; i--) {
        if (_client.available() < 1) return;
        len |= ((uint64_t)_client.read() << (i * 8));
      }
    }

    uint8_t buf[512];
    size_t readLen = 0;
    while (readLen < len) {
      size_t remaining = len - readLen;
      size_t chunk = remaining > 256 ? 256 : remaining;
      if (_client.available() < (int)chunk) chunk = _client.available();
      if (chunk == 0) break;
      int r = _client.read(buf + readLen, chunk);
      if (r > 0) readLen += r;
      else break;
    }

    if (opcode == 0x1) {
      if (readLen < sizeof(buf)) buf[readLen] = 0;
      _fireEvent(WStype_TEXT, buf, readLen);
    } else if (opcode == 0x8) {
      _client.stop();
      _state = WS_IDLE;
      _reconnectTimer = millis() + 3000;
      _fireEvent(WStype_DISCONNECTED, nullptr, 0);
    } else if (opcode == 0x9) {
      _sendFrame(0xA, nullptr, 0);
    }
  }

  void _fireEvent(WStype type, uint8_t* data, size_t len) {
    if (_callback) _callback(type, data, len);
  }
};

NexioWebSocket webSocketClient;
