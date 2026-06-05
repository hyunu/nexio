#include <WiFi.h>
#include <Preferences.h>
#include "config.h"

Preferences preferences;

String getWifiSsid() {
  preferences.begin(NVS_NAMESPACE, true);
  String val = preferences.getString(KEY_WIFI_SSID, "");
  preferences.end();
  return val;
}

String getWifiPass() {
  preferences.begin(NVS_NAMESPACE, true);
  String val = preferences.getString(KEY_WIFI_PASS, "");
  preferences.end();
  return val;
}

String getServerUrl() {
  preferences.begin(NVS_NAMESPACE, true);
  String val = preferences.getString(KEY_SERVER_URL, "");
  preferences.end();
  return val;
}

String getUniqueId() {
  preferences.begin(NVS_NAMESPACE, true);
  String val = preferences.getString(KEY_UNIQUE_ID, "");
  preferences.end();
  return val;
}

bool loadConfig() {
  return getWifiSsid().length() > 0;
}

void saveConfig(const String& ssid, const String& pass, const String& url, const String& uniqueId) {
  preferences.begin(NVS_NAMESPACE, false);
  preferences.putString(KEY_WIFI_SSID, ssid);
  preferences.putString(KEY_WIFI_PASS, pass);
  preferences.putString(KEY_SERVER_URL, url);
  if (uniqueId.length() > 0) {
    preferences.putString(KEY_UNIQUE_ID, uniqueId);
  }
  preferences.end();
}

void clearConfig() {
  preferences.begin(NVS_NAMESPACE, false);
  preferences.remove(KEY_WIFI_SSID);
  preferences.remove(KEY_WIFI_PASS);
  preferences.remove(KEY_SERVER_URL);
  preferences.end();
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
