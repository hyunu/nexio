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
  }

  void onDisconnect(NimBLEServer* pServer) {
    bleConnected = false;
  }
};

class RxCallbacks: public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) {
    std::string value = pCharacteristic->getValue();
    if (value.length() > 0) {
      String data = String(value.c_str());

      StaticJsonDocument<512> doc;
      DeserializationError error = deserializeJson(doc, data);

      if (!error) {
        if (doc.containsKey("ssid")) receivedSsid = doc["ssid"].as<String>();
        if (doc.containsKey("password")) receivedPass = doc["password"].as<String>();
        if (doc.containsKey("serverUrl")) receivedUrl = doc["serverUrl"].as<String>();
        if (doc.containsKey("uniqueId")) receivedUniqueId = doc["uniqueId"].as<String>();

        if (receivedSsid.length() > 0 && receivedPass.length() > 0 && receivedUrl.length() > 0) {
          onWiFiConfigured(receivedSsid, receivedPass, receivedUrl, receivedUniqueId);
          receivedSsid = "";
          receivedPass = "";
          receivedUrl = "";
          receivedUniqueId = "";
        }
      }
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
  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();

  if (pAdvertising->isAdvertising()) {
    pAdvertising->stop();
  }

  NimBLEAdvertisementData advData;
  advData.setFlags(BLE_HS_ADV_F_DISC_GEN);

  uint8_t mfgData[5] = {
    (uint8_t)(BLE_MFG_COMPANY_ID & 0xFF),
    (uint8_t)(BLE_MFG_COMPANY_ID >> 8),
    bleStatusFlags,
    0x01,
    0x00
  };
  advData.setManufacturerData(std::string((char*)mfgData, 5));

  pAdvertising->setAdvertisementData(advData);

  NimBLEAdvertisementData scanRspData;
  if (bleUniqueId.length() > 0) {
    String fullName = "Nexio-" + bleUniqueId;
    scanRspData.setName(fullName.c_str());
  } else {
    scanRspData.setName(BLE_DEVICE_NAME);
  }
  scanRspData.setServices(NimBLEUUID(BLE_SERVICE_UUID));

  pAdvertising->setScanResponseData(scanRspData);
  pAdvertising->addServiceUUID(NimBLEUUID(BLE_SERVICE_UUID));

  pAdvertising->start();
  bleAdvertisingActive = true;
}

void startBLEAdvertising() {
  if (bleAdvertisingActive) return;
  updateAdvertising();
}

void stopBLE() {
  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
  if (pAdvertising->isAdvertising()) {
    pAdvertising->stop();
  }
  bleAdvertisingActive = false;
}

void setBleStatus(uint8_t flags) {
  bleStatusFlags = flags;
  if (bleAdvertisingActive) {
    updateAdvertising();
  }
}

void handleBLE() {
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
