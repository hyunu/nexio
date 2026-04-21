#include <TFT_eSPI.h>
#include <SPI.h>
#include "config.h"

TFT_eSPI tft = TFT_eSPI();

void initDisplay(TFT_eSPI& display) {
  tft.init();
  tft.setRotation(1);
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.setTextSize(2);
}

void displayStatus(const String& status) {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.setTextSize(2);
  tft.drawString("Nexio", 10, 10);
  tft.setTextSize(1);
  tft.drawString(status, 10, 40);
}

void displayWiFiStatus(const String& ssid, bool connected) {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.setTextSize(2);
  tft.drawString("Nexio", 10, 10);

  tft.setTextSize(1);
  if (connected) {
    tft.setTextColor(TFT_GREEN, TFT_BLACK);
    tft.drawString("WiFi: Connected", 10, 50);
  } else {
    tft.setTextColor(TFT_RED, TFT_BLACK);
    tft.drawString("WiFi: Disconnected", 10, 50);
  }

  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.drawString("SSID: " + ssid, 10, 70);
}

void displayWsStatus(bool connected) {
  tft.setTextSize(1);
  if (connected) {
    tft.setTextColor(TFT_GREEN, TFT_BLACK);
    tft.drawString("WS: Connected", 10, 90);
  } else {
    tft.setTextColor(TFT_RED, TFT_BLACK);
    tft.drawString("WS: Disconnected", 10, 90);
  }
}

void displayId(const String& id) {
  tft.setTextSize(1);
  tft.setTextColor(TFT_CYAN, TFT_BLACK);
  tft.drawString("ID: " + id, 10, 110);
}

void displayClear() {
  tft.fillScreen(TFT_BLACK);
}
