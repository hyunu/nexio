#ifndef CONFIG_H
#define CONFIG_H

#define NVS_NAMESPACE "nexio_config"
#define KEY_WIFI_SSID "wifi_ssid"
#define KEY_WIFI_PASS "wifi_pass"
#define KEY_SERVER_URL "server_url"

#define UART_BAUD 115200
#define UART_TX_PIN 7
#define UART_RX_PIN 6

#define BLE_DEVICE_NAME "Nexio-ESP32"
#define BLE_SERVICE_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_CHAR_TX_UUID "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_CHAR_RX_UUID "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

#define WS_RECONNECT_INTERVAL 5000
#define WIFI_RECONNECT_INTERVAL 3000
#define HEARTBEAT_INTERVAL 30000

#define MESSAGE_VERSION "1.0"

#define DISPLAY_CS_PIN 10
#define DISPLAY_DC_PIN 2
#define DISPLAY_RST_PIN 3
#define DISPLAY_SCK_PIN 10
#define DISPLAY_MOSI_PIN 7
#define DISPLAY_MISO_PIN 8

#define DISPLAY_WIDTH 240
#define DISPLAY_HEIGHT 240

#endif
