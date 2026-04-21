#include <WiFi.h>
#include <NVS.h>
#include "config.h"

nvs_handle_t nvs;

String getWifiSsid() {
  char ssid[32] = {0};
  size_t len = sizeof(ssid);
  nvs_get_str(nvs, KEY_WIFI_SSID, ssid, &len);
  return String(ssid);
}

String getWifiPass() {
  char pass[64] = {0};
  size_t len = sizeof(pass);
  nvs_get_str(nvs, KEY_WIFI_PASS, pass, &len);
  return String(pass);
}

String getServerUrl() {
  char url[128] = {0};
  size_t len = sizeof(url);
  nvs_get_str(nvs, KEY_SERVER_URL, url, &len);
  return String(url);
}

void initWifi() {
  nvs_begin(NVS_DEFAULT_PARTITION, NVS_MODE_READWRITE);
}

bool loadConfig() {
  nvs_begin(NVS_DEFAULT_PARTITION, NVS_MODE_READONLY);

  char ssid[32] = {0};
  size_t len = sizeof(ssid);
  esp_err_t err = nvs_get_str(nvs, KEY_WIFI_SSID, ssid, &len);

  nvs_close();

  return err == ESP_OK && strlen(ssid) > 0;
}

void saveConfig(const String& ssid, const String& pass, const String& url) {
  nvs_begin(NVS_DEFAULT_PARTITION, NVS_MODE_READWRITE);

  nvs_set_str(nvs, KEY_WIFI_SSID, ssid.c_str());
  nvs_set_str(nvs, KEY_WIFI_PASS, pass.c_str());
  nvs_set_str(nvs, KEY_SERVER_URL, url.c_str());

  nvs_commit(nvs);
  nvs_close();
}

void clearConfig() {
  nvs_begin(NVS_DEFAULT_PARTITION, NVS_MODE_READWRITE);
  nvs_erase_key(nvs, KEY_WIFI_SSID);
  nvs_erase_key(nvs, KEY_WIFI_PASS);
  nvs_erase_key(nvs, KEY_SERVER_URL);
  nvs_commit(nvs);
  nvs_close();
}

bool isWifiConnected() {
  return WiFi.status() == WL_CONNECTED;
}

String getMacAddress() {
  return WiFi.macAddress();
}

int getRssi() {
  return WiFi.RSSI();
}
