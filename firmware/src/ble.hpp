#include <NimBLEDevice.h>
#include <NimBLEServer.h>
#include <NimBLEUtils.h>
#include <ArduinoJson.h>
#include "config.h"

NimBLEServer* pServer = nullptr;
NimBLEService* pService = nullptr;
NimBLECharacteristic* pTxCharacteristic = nullptr;
NimBLECharacteristic* pRxCharacteristic = nullptr;

bool bleConnected = false;
bool bleDataProcessed = false;
uint8_t bleStatusFlags = 0;

static String bleUniqueId = "";
static bool bleAdvertisingActive = false;

String receivedSsid = "";
String receivedPass = "";
String receivedUrl = "";
String receivedUniqueId = "";

extern void onWiFiConfigured(const String& ssid, const String& pass, const String& url, const String& uniqueId);

class ServerCallbacks: public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* pServer) {
    bleConnected = true;
    Serial.println("[BLE] Client connected");
  }

  void onDisconnect(NimBLEServer* pServer) {
    bleConnected = false;
    Serial.println("[BLE] Client disconnected");
  }
};

class RxCallbacks: public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) {
    std::string value = pCharacteristic->getValue();
    if (value.length() > 0) {
      String data = String(value.c_str());
      Serial.println("[BLE_RX] Data received!");
      Serial.print("[BLE_RX] Raw: "); Serial.println(data);

      StaticJsonDocument<512> doc;
      DeserializationError error = deserializeJson(doc, data);

      if (error) {
        Serial.print("[BLE_RX] JSON parse error: ");
        Serial.println(error.c_str());
        return;
      }

      if (doc.containsKey("ssid")) {
        receivedSsid = doc["ssid"].as<String>();
        Serial.print("[BLE_RX] ssid: "); Serial.println(receivedSsid);
      }
      if (doc.containsKey("password")) {
        receivedPass = doc["password"].as<String>();
        Serial.print("[BLE_RX] password: "); Serial.println(receivedPass);
      }
      if (doc.containsKey("serverUrl")) {
        receivedUrl = doc["serverUrl"].as<String>();
        Serial.print("[BLE_RX] serverUrl: "); Serial.println(receivedUrl);
      }
      if (doc.containsKey("uniqueId")) {
        receivedUniqueId = doc["uniqueId"].as<String>();
        Serial.print("[BLE_RX] uniqueId: "); Serial.println(receivedUniqueId);
      }

      if (receivedSsid.length() > 0 && receivedPass.length() > 0 && receivedUrl.length() > 0) {
        Serial.println("[BLE_RX] All fields received, calling onWiFiConfigured");
        onWiFiConfigured(receivedSsid, receivedPass, receivedUrl, receivedUniqueId);
        receivedSsid = "";
        receivedPass = "";
        receivedUrl = "";
        receivedUniqueId = "";
      } else {
        Serial.println("[BLE_RX] Missing required fields:");
        if (receivedSsid.length() == 0) Serial.println("  - ssid");
        if (receivedPass.length() == 0) Serial.println("  - password");
        if (receivedUrl.length() == 0) Serial.println("  - serverUrl");
      }
    } else {
      Serial.println("[BLE_RX] Empty write received");
    }
  }
};

void initBLE() {
  NimBLEDevice::init(BLE_DEVICE_NAME);
  pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  pService = pServer->createService(BLE_SERVICE_UUID);

  pTxCharacteristic = pService->createCharacteristic(
    BLE_CHAR_TX_UUID,
    NIMBLE_PROPERTY::NOTIFY
  );

  pRxCharacteristic = pService->createCharacteristic(
    BLE_CHAR_RX_UUID,
    NIMBLE_PROPERTY::WRITE
  );
  pRxCharacteristic->setCallbacks(new RxCallbacks());

  pService->start();
}

void setBleUniqueId(const String& id) {
  bleUniqueId = id;
}

void updateAdvertising() {
  if (pServer == nullptr) return;
  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();

  if (pAdvertising->isAdvertising()) {
    pAdvertising->stop();
    delay(100);
  }

  pAdvertising->setConnectableMode(BLE_GAP_CONN_MODE_UND);
  pAdvertising->setDiscoverableMode(BLE_GAP_DISC_MODE_GEN);

  NimBLEAdvertisementData advData;
  advData.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);

  uint8_t mfgData[5] = {
    (uint8_t)(BLE_MFG_COMPANY_ID & 0xFF),
    (uint8_t)(BLE_MFG_COMPANY_ID >> 8),
    bleStatusFlags,
    0x01,
    0x00
  };
  advData.setManufacturerData(std::string((char*)mfgData, 5));
  advData.setCompleteServices(NimBLEUUID(BLE_SERVICE_UUID));

  pAdvertising->setAdvertisementData(advData);
  pAdvertising->addServiceUUID(NimBLEUUID(BLE_SERVICE_UUID));

  NimBLEAdvertisementData scanRspData;
  if (bleUniqueId.length() > 0) {
    String fullName = "Nexio-" + bleUniqueId;
    scanRspData.setName(fullName.c_str());
  } else {
    scanRspData.setName(BLE_DEVICE_NAME);
  }
  pAdvertising->setScanResponseData(scanRspData);

  if (pAdvertising->start()) {
    bleAdvertisingActive = true;
  } else {
    bleAdvertisingActive = false;
  }
}

void startBLEAdvertising() {
  if (pServer == nullptr) return;
  if (bleAdvertisingActive) return;
  updateAdvertising();
}

void stopBLE() {
  if (pServer == nullptr) return;
  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
  if (pAdvertising->isAdvertising()) {
    pAdvertising->stop();
  }
  bleAdvertisingActive = false;
}

void setBleStatus(uint8_t flags) {
  bleStatusFlags = flags;
  if (bleAdvertisingActive && pServer != nullptr) {
    updateAdvertising();
  }
}

void handleBLE() {
  if (pServer == nullptr) return;
  int connCount = pServer->getConnectedCount();
  if (connCount > 0 && !bleConnected) {
    bleConnected = true;
    bleDataProcessed = false;
    Serial.println("[BLE] Client connected");
  } else if (connCount == 0 && bleConnected) {
    bleConnected = false;
    Serial.println("[BLE] Client disconnected");
  }

  if (pRxCharacteristic != nullptr && bleConnected && !bleDataProcessed) {
    std::string value = pRxCharacteristic->getValue();
    if (value.length() > 0) {
      String data = String(value.c_str());
      Serial.println("[BLE_RX] Data received!");
      Serial.print("[BLE_RX] Raw: "); Serial.println(data);

      StaticJsonDocument<512> doc;
      DeserializationError error = deserializeJson(doc, data);

      if (error) {
        Serial.print("[BLE_RX] JSON parse error: ");
        Serial.println(error.c_str());
        return;
      }

      if (doc.containsKey("ssid")) {
        receivedSsid = doc["ssid"].as<String>();
        Serial.print("[BLE_RX] ssid: "); Serial.println(receivedSsid);
      }
      if (doc.containsKey("password")) {
        receivedPass = doc["password"].as<String>();
        Serial.print("[BLE_RX] password: "); Serial.println(receivedPass);
      }
      if (doc.containsKey("serverUrl")) {
        receivedUrl = doc["serverUrl"].as<String>();
        Serial.print("[BLE_RX] serverUrl: "); Serial.println(receivedUrl);
      }
      if (doc.containsKey("uniqueId")) {
        receivedUniqueId = doc["uniqueId"].as<String>();
        Serial.print("[BLE_RX] uniqueId: "); Serial.println(receivedUniqueId);
      }

      if (receivedSsid.length() > 0 && receivedPass.length() > 0 && receivedUrl.length() > 0) {
        Serial.println("[BLE_RX] All fields received, calling onWiFiConfigured");
        bleDataProcessed = true;
        onWiFiConfigured(receivedSsid, receivedPass, receivedUrl, receivedUniqueId);
        receivedSsid = "";
        receivedPass = "";
        receivedUrl = "";
        receivedUniqueId = "";
      } else {
        Serial.println("[BLE_RX] Missing required fields:");
        if (receivedSsid.length() == 0) Serial.println("  - ssid");
        if (receivedPass.length() == 0) Serial.println("  - password");
        if (receivedUrl.length() == 0) Serial.println("  - serverUrl");
      }
    }
  }
}

bool isBleConnected() {
  return bleConnected;
}

bool isBleAdvertising() {
  return bleAdvertisingActive;
}

void resumeBLE() {
  if (!bleAdvertisingActive) {
    startBLEAdvertising();
  }
}
