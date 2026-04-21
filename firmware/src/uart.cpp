#include <HardwareSerial.h>
#include "config.h"

extern void sendDataToServer(const uint8_t* data, size_t len);

void initUART() {
  Serial.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);
}

void handleUART() {
  if (Serial.available()) {
    uint8_t buffer[512];
    size_t count = 0;

    while (Serial.available() && count < sizeof(buffer)) {
      buffer[count++] = Serial.read();
    }

    if (count > 0) {
      sendDataToServer(buffer, count);
    }
  }
}

size_t readUART(uint8_t* buffer, size_t maxLen) {
  size_t count = 0;
  while (Serial.available() && count < maxLen) {
    buffer[count++] = Serial.read();
  }
  return count;
}

void writeUART(const uint8_t* data, size_t len) {
  Serial.write(data, len);
}
