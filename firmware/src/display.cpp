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

static void drawIndicator(int x, int y, bool on) {
  tft.fillCircle(x, y, 4, on ? TFT_GREEN : TFT_RED);
}

void displayNexioStatus(bool wifiOn, bool svrOn, bool prdOn, const String& ssid, const String& uniqueId) {
  tft.fillScreen(TFT_BLACK);

  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.setTextSize(2);
  tft.drawString("Nexio", 10, 8);

  if (uniqueId.length() > 0) {
    tft.setTextSize(1);
    tft.setTextColor(TFT_CYAN, TFT_BLACK);
    tft.drawString("ID: " + uniqueId, 10, 32);
  }

  int yBase = 60;
  tft.setTextSize(1);

  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.drawString("WiFi", 10, yBase);
  drawIndicator(60, yBase + 4, wifiOn);
  if (ssid.length() > 0) {
    tft.drawString(ssid.substring(0, 16), 80, yBase);
  }

  tft.drawString("SVR", 10, yBase + 20);
  drawIndicator(60, yBase + 24, svrOn);

  tft.drawString("PRD", 10, yBase + 40);
  drawIndicator(60, yBase + 44, prdOn);

  if (!wifiOn && !svrOn && !prdOn && uniqueId.length() == 0) {
    tft.setTextColor(TFT_YELLOW, TFT_BLACK);
    tft.drawString("BLE waiting...", 10, yBase + 70);
    tft.drawString("Use Nexio App", 10, yBase + 84);
  }
}

void displayClear() {
  tft.fillScreen(TFT_BLACK);
}
