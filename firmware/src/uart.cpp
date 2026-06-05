#include <HardwareSerial.h>
#include "config.h"

extern void sendDataToServer(const uint8_t* data, size_t len);

static unsigned long lastProductRxTime = 0;
static unsigned long lastProbeTime = 0;

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
      lastProductRxTime = millis();
      sendDataToServer(buffer, count);
    }
  }
}

bool isProductConnected() {
  if (lastProductRxTime == 0) return false;
  return (millis() - lastProductRxTime) < PRODUCT_TIMEOUT_MS;
}

void sendProductProbe() {
  unsigned long now = millis();
  if (lastProductRxTime != 0 && (now - lastProbeTime) >= PRODUCT_PROBE_INTERVAL_MS) {
    lastProbeTime = now;
    uint8_t probe = 0x00;
    Serial.write(&probe, 1);
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

void resetProductTimer() {
  lastProductRxTime = 0;
}
