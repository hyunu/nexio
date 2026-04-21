import 'dart:async';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

class BleScanner {
  static const String _serviceUuid = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  static const String _charWriteUuid = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

  StreamController<List<ScanResult>>? _scanController;

  Stream<List<ScanResult>> get scanResults {
    _scanController ??= StreamController<List<ScanResult>>.broadcast();
    return _scanController!.stream;
  }

  Future<void> startScan({Duration timeout = const Duration(seconds: 10)}) async {
    _scanController ??= StreamController<List<ScanResult>>.broadcast();

    await FlutterBluePlus.startScan(
      withServices: [Guid(_serviceUuid)],
      timeout: timeout,
    );

    FlutterBluePlus.scanResults.listen((results) {
      _scanController?.add(results);
    });
  }

  Future<void> stopScan() async {
    await FlutterBluePlus.stopScan();
  }

  Future<bool> sendConfig(
    BluetoothDevice device,
    Map<String, String> config,
  ) async {
    try {
      List<BluetoothService> services = await device.discoverServices();

      for (var service in services) {
        if (service.uuid.str.toLowerCase() == _serviceUuid.toLowerCase()) {
          for (var characteristic in service.characteristics) {
            if (characteristic.uuid.str.toLowerCase() ==
                _charWriteUuid.toLowerCase()) {
              String jsonString = _createConfigJson(config);
              await characteristic.write(jsonString.codeUnits);
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