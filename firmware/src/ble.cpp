#include <NimBLEDevice.h>
#include <NimBLEServer.h>
#include <NimBLEUtils.h>
#include <ArduinoJson.h>
#include "config.h"

class BleCallbacks;
class CharacteristicCallbacks;

NimBLEServer* pServer = nullptr;
NimBLEService* pService = nullptr;
NimBLECharacteristic* pTxCharacteristic = nullptr;
NimBLECharacteristic* pRxCharacteristic = nullptr;

bool bleConfigured = false;
bool bleConnected = false;

String receivedSsid = "";
String receivedPass = "";
String receivedUrl = "";

extern void onWiFiConfigured(const String& ssid, const String& pass, const String& url);

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

        if (receivedSsid.length() > 0 && receivedPass.length() > 0 && receivedUrl.length() > 0) {
          onWiFiConfigured(receivedSsid, receivedPass, receivedUrl);
          receivedSsid = "";
          receivedPass = "";
          receivedUrl = "";
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

void startBLEAdvertising() {
  NimBLEAdvertisementData advertisementData;
  advertisementData.setName(BLE_DEVICE_NAME);
  advertisementData.setServices(NimBLEUUID(BLE_SERVICE_UUID));
  advertisementData.setConnectable(true);

  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(NimBLEUUID(BLE_SERVICE_UUID));
  pAdvertising->setScanResponseData(advertisementData);
  pAdvertising->start();
}

void handleBLE() {
}

bool isBleConnected() {
  return bleConnected;
}

void stopBLE() {
  NimBLEDevice::getAdvertising()->stop();
}
