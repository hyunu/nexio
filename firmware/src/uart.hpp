#include <HardwareSerial.h>
#include "config.h"

extern void sendDataToServer(const uint8_t* data, size_t len);

static unsigned long lastProductRxTime = 0;
static unsigned long lastProbeTime = 0;

void initUART() {
  // Avoid initializing Serial1 on pins that are connected to the onboard flash
  // (typically GPIO6-GPIO11). Using those pins for peripherals can cause
  // boot failures / continuous reboot loops on ESP32-C3 modules.
  if ((UART_RX_PIN >= 6 && UART_RX_PIN <= 11) || (UART_TX_PIN >= 6 && UART_TX_PIN <= 11)) {
    Serial.println("[UART] Warning: UART pins overlap flash pins; skipping Serial1 init to avoid boot issues");
    return;
  }
  Serial1.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);
}

void handleUART() {
  if (Serial1.available()) {
    uint8_t buffer[512];
    size_t count = 0;

    while (Serial1.available() && count < sizeof(buffer)) {
      buffer[count++] = Serial1.read();
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
    Serial1.write(&probe, 1);
  }
}

size_t readUART(uint8_t* buffer, size_t maxLen) {
  size_t count = 0;
  while (Serial1.available() && count < maxLen) {
    buffer[count++] = Serial1.read();
  }
  return count;
}

void writeUART(const uint8_t* data, size_t len) {
  Serial1.write(data, len);
}

void resetProductTimer() {
  lastProductRxTime = 0;
}
