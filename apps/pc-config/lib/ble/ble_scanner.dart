import 'package:flutter_web_bluetooth/flutter_web_bluetooth.dart';

class BleScanner {
  static const String _serviceUuid = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  static const String _charWriteUuid = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

  Future<List<BluetoothDevice>> startScan() async {
    final adapter = FlutterWebBluetooth.instance.adapter;

    final isAvailable = await adapter.isAvailable();
    if (!isAvailable) {
      throw Exception('Bluetooth is not available');
    }

    final isPoweredOn = await adapter.isPoweredOn();
    if (!isPoweredOn) {
      await adapter.enable();
    }

    final devices = await adapter.scanForDevices(
      withServices: [Guid(_serviceUuid)],
      timeout: const Duration(seconds: 10),
    );

    return devices;
  }

  Future<bool> sendConfig(
    BluetoothDevice device,
    Map<String, String> config,
  ) async {
    try {
      await device.connect();

      final services = await device.discoverServices();

      for (var service in services) {
        if (service.uuid.toLowerCase() == _serviceUuid.toLowerCase()) {
          final characteristics = await service.getCharacteristics();

          for (var characteristic in characteristics) {
            if (characteristic.uuid.toLowerCase() == _charWriteUuid.toLowerCase()) {
              String jsonString = _createConfigJson(config);
              await characteristic.writeValueWithResponse(
                jsonString.codeUnits,
              );
              return true;
            }
          }
        }
      }

      return false;
    } catch (e) {
      return false;
    }
  }

  String _createConfigJson(Map<String, String> config) {
    final buffer = StringBuffer();
    buffer.write('{');
    buffer.write('"ssid":"${_escapeJson(config['ssid'] ?? '')}",');
    buffer.write('"password":"${_escapeJson(config['password'] ?? '')}",');
    buffer.write('"serverUrl":"${_escapeJson(config['serverUrl'] ?? '')}"');
    buffer.write('}');
    return buffer.toString();
  }

  String _escapeJson(String value) {
    return value
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '\\r');
  }
}
