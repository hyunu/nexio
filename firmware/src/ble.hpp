#include <nvs_flash.h>
#include <esp_bt.h>
#include <esp_nimble_hci.h>
#include <nimble/nimble_port.h>
#include <nimble/nimble_port_freertos.h>
#include <host/ble_hs.h>
#include <host/ble_gap.h>
#include <host/ble_gatt.h>
#include <host/ble_hs_mbuf.h>
#include <services/gap/ble_svc_gap.h>
#include <services/gatt/ble_svc_gatt.h>
#include "config.h"

static const ble_uuid128_t gatt_svc_uuid = BLE_UUID128_INIT(
  0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
  0x93, 0xf3, 0xa3, 0xb5, 0x01, 0x00, 0x40, 0x6e
);
static const ble_uuid128_t gatt_chr_tx_uuid = BLE_UUID128_INIT(
  0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
  0x93, 0xf3, 0xa3, 0xb5, 0x02, 0x00, 0x40, 0x6e
);
static const ble_uuid128_t gatt_chr_rx_uuid = BLE_UUID128_INIT(
  0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
  0x93, 0xf3, 0xa3, 0xb5, 0x03, 0x00, 0x40, 0x6e
);

static uint16_t gatt_chr_tx_handle;
static uint16_t gatt_chr_rx_handle;
static uint16_t conn_handle = BLE_HS_CONN_HANDLE_NONE;

bool bleConnected = false;
uint8_t bleStatusFlags = 0;
String blePendingAction = "";
static String bleUniqueId = "";
static String bleLastProcessedValue = "";
static bool ble_synced = false;

extern void onWiFiConfigured(const String& ssid, const String& pass, const String& url, const String& uniqueId);

static int gatt_svc_access(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt *ctxt, void *arg);
static void startBLEAdvertising();

static const struct ble_gatt_svc_def gatt_svcs[] = {
  {
    .type = BLE_GATT_SVC_TYPE_PRIMARY,
    .uuid = &gatt_svc_uuid.u,
    .characteristics = (struct ble_gatt_chr_def[]) { {
      .uuid = &gatt_chr_tx_uuid.u,
      .access_cb = gatt_svc_access,
      .flags = BLE_GATT_CHR_F_NOTIFY,
    }, {
      .uuid = &gatt_chr_rx_uuid.u,
      .access_cb = gatt_svc_access,
      .flags = BLE_GATT_CHR_F_WRITE,
    }, {
      0,
    } },
  }, {
    0,
  },
};

static int gatt_svc_access(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt *ctxt, void *arg) {
  if (ble_uuid_cmp(ctxt->chr->uuid, &gatt_chr_rx_uuid.u) == 0) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
      char buf[512];
      uint16_t len;
      ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf) - 1, &len);
      buf[len] = '\0';
      String data = String(buf);
      Serial.print("[BLE_RX] "); Serial.println(data);

      if (data.startsWith("{")) {
        if (data.indexOf("\"action\"") > 0) {
          int a = data.indexOf("\"action\":\"") + 10;
          int b = data.indexOf("\"", a);
          if (a > 9 && b > a) {
            bleLastProcessedValue = data;
            blePendingAction = data.substring(a, b);
            return 0;
          }
        }

        String ssid = "", pass = "", url = "", uid = "";
        int p, q;

        p = data.indexOf("\"ssid\":\"");
        if (p > 0) { p += 8; q = data.indexOf("\"", p); if (q > p) ssid = data.substring(p, q); }

        p = data.indexOf("\"password\":\"");
        if (p > 0) { p += 12; q = data.indexOf("\"", p); if (q > p) pass = data.substring(p, q); }

        p = data.indexOf("\"serverUrl\":\"");
        if (p > 0) { p += 13; q = data.indexOf("\"", p); if (q > p) url = data.substring(p, q); }

        p = data.indexOf("\"uniqueId\":\"");
        if (p > 0) { p += 12; q = data.indexOf("\"", p); if (q > p) uid = data.substring(p, q); }

        if (ssid.length() > 0 && pass.length() > 0 && url.length() > 0) {
          bleLastProcessedValue = data;
          onWiFiConfigured(ssid, pass, url, uid);
        }
      }
      return 0;
    }
  }
  return BLE_ATT_ERR_UNLIKELY;
}

static void ble_on_sync(void) {
  ble_synced = true;
  Serial.println("[BLE] Host synced");

  ble_gatts_find_chr(&gatt_svc_uuid.u, &gatt_chr_tx_uuid.u, NULL, &gatt_chr_tx_handle);
  ble_gatts_find_chr(&gatt_svc_uuid.u, &gatt_chr_rx_uuid.u, NULL, &gatt_chr_rx_handle);
  Serial.printf("[BLE] TX handle=%d RX handle=%d\n", gatt_chr_tx_handle, gatt_chr_rx_handle);
}

static void ble_on_reset(int reason) {
  Serial.printf("[BLE] Reset: reason=%d\n", reason);
}

static int ble_gap_event(struct ble_gap_event *event, void *arg) {
  switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
      if (event->connect.status == 0) {
        conn_handle = event->connect.conn_handle;
        bleConnected = true;
        Serial.println("[BLE] Client connected");
      } else {
        Serial.println("[BLE] Connect failed");
      }
      break;
    case BLE_GAP_EVENT_DISCONNECT:
      conn_handle = BLE_HS_CONN_HANDLE_NONE;
      bleConnected = false;
      bleLastProcessedValue = "";
      Serial.println("[BLE] Client disconnected");
      startBLEAdvertising();
      break;
    case BLE_GAP_EVENT_ADV_COMPLETE:
      startBLEAdvertising();
      break;
    default:
      break;
  }
  return 0;
}

static void ble_host_task(void *param) {
  nimble_port_run();
  nimble_port_freertos_deinit();
}

void initBLE() {
  if (!IS_FLASH_PIN(STATUS_LED_PIN)) digitalWrite(STATUS_LED_PIN, HIGH);

  Serial.print("[BLE] NVS init... "); Serial.flush();
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    err = nvs_flash_init();
  }
  Serial.println(err == ESP_OK ? "OK" : "FAIL"); Serial.flush();

  Serial.print("[BLE] Controller init... "); Serial.flush();
  esp_bt_controller_config_t bt_cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
  err = esp_bt_controller_init(&bt_cfg);
  if (err != ESP_OK) {
    Serial.printf("FAIL (%d), continuing without BLE\n", err); Serial.flush();
    return;
  }
  err = esp_bt_controller_enable(ESP_BT_MODE_BLE);
  if (err != ESP_OK) {
    Serial.printf("FAIL enable (%d), continuing without BLE\n", err); Serial.flush();
    return;
  }
  Serial.println("OK"); Serial.flush();

  Serial.print("[BLE] NimBLE init... "); Serial.flush();
  err = esp_nimble_init();
  if (err != ESP_OK) {
    Serial.printf("FAIL (%d), continuing without BLE\n", err); Serial.flush();
    return;
  }
  Serial.println("OK"); Serial.flush();

  ble_hs_cfg.reset_cb = ble_on_reset;
  ble_hs_cfg.sync_cb = ble_on_sync;
  ble_hs_cfg.store_status_cb = NULL;
  ble_hs_cfg.sm_io_cap = BLE_HS_IO_NO_INPUT_OUTPUT;
  ble_hs_cfg.sm_bonding = 0;
  ble_hs_cfg.sm_mitm = 0;
  ble_hs_cfg.sm_sc = 1;

  Serial.print("[BLE] GAP/GATT svc init... "); Serial.flush();
  ble_svc_gap_init();
  ble_svc_gatt_init();

  ble_gatts_count_cfg(gatt_svcs);
  ble_gatts_add_svcs(gatt_svcs);
  Serial.println("OK"); Serial.flush();

  Serial.print("[BLE] NimBLE task start... "); Serial.flush();
  nimble_port_freertos_init(ble_host_task);

  int timeout = 500;
  while (!ble_synced && timeout > 0) {
    vTaskDelay(10 / portTICK_PERIOD_MS);
    timeout--;
  }
  Serial.println(ble_synced ? "OK" : "TIMEOUT"); Serial.flush();

  if (!IS_FLASH_PIN(STATUS_LED_PIN)) digitalWrite(STATUS_LED_PIN, LOW);
}

void setBleUniqueId(const String& id) {
  bleUniqueId = id;
}

void bleLog(const String& msg) {
  if (conn_handle == BLE_HS_CONN_HANDLE_NONE || gatt_chr_tx_handle == 0) return;
  struct os_mbuf *om = ble_hs_mbuf_from_flat(msg.c_str(), msg.length());
  if (om == NULL) return;
  if (ble_gattc_notify_custom(conn_handle, gatt_chr_tx_handle, om) != 0) {
    os_mbuf_free_chain(om);
  }
  Serial.print("[BLE_TX] "); Serial.println(msg);
}

void startBLEAdvertising() {
  if (!ble_synced) return;

  struct ble_gap_adv_params adv_params;
  memset(&adv_params, 0, sizeof(adv_params));
  adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
  adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;

  struct ble_hs_adv_fields adv_data;
  memset(&adv_data, 0, sizeof(adv_data));
  adv_data.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;

  uint8_t mfgData[5] = {
    (uint8_t)(BLE_MFG_COMPANY_ID & 0xFF),
    (uint8_t)(BLE_MFG_COMPANY_ID >> 8),
    bleStatusFlags, 0x01, 0x00
  };
  adv_data.mfg_data = mfgData;
  adv_data.mfg_data_len = 5;

  ble_gap_adv_set_fields(&adv_data);

  struct ble_hs_adv_fields rsp_data;
  memset(&rsp_data, 0, sizeof(rsp_data));

  String name = (bleUniqueId.length() > 0) ? "Nexio-" + bleUniqueId : String(BLE_DEVICE_NAME);
  rsp_data.name = (uint8_t*)name.c_str();
  rsp_data.name_len = name.length();
  rsp_data.name_is_complete = 1;

  rsp_data.uuids128 = (ble_uuid128_t*)&gatt_svc_uuid;
  rsp_data.num_uuids128 = 1;
  rsp_data.uuids128_is_complete = 1;

  ble_gap_adv_rsp_set_fields(&rsp_data);

  int rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL, BLE_HS_FOREVER, &adv_params, ble_gap_event, NULL);
  if (rc == 0) {
    Serial.println("[BLE] Advertising started");
  } else {
    Serial.printf("[BLE] Advertising start failed: %d\n", rc);
  }
}

void setBleStatus(uint8_t flags) {
  if (flags == bleStatusFlags) return;
  bleStatusFlags = flags;
}

void handleBLE() {
}

bool isBleConnected() {
  return bleConnected;
}

bool isBleAdvertising() {
  return ble_synced;
}

void resumeBLE() {
  startBLEAdvertising();
}
