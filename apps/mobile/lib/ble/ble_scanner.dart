import 'dart:async';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

enum NexioDeviceState {
  unconfigured,
  configuring,
  connecting,
  connected,
  fullConnected,
  wifiOnly,
}

class BleScanner {
  static const String _serviceUuid = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  static const String _charWriteUuid = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

  static const int _mfgCompanyId = 0x02D5;
  static const int _flagPrd = 0x01;
  static const int _flagSvr = 0x02;
  static const int _flagWifi = 0x04;
  static const int _flagCfg = 0x08;

  StreamController<List<ScanResult>>? _scanController;

  Stream<List<ScanResult>> get scanResults {
    _scanController ??= StreamController<List<ScanResult>>.broadcast();
    return _scanController!.stream;
  }

  static NexioDeviceState parseStateFromAdData(AdvertisementData? data) {
    if (data == null) return NexioDeviceState.unconfigured;

    final mfgData = data.manufacturerData;
    if (mfgData == null || mfgData.isEmpty) {
      return NexioDeviceState.unconfigured;
    }

    if (mfgData.length < 3) return NexioDeviceState.unconfigured;

    final companyId = (mfgData[1] << 8) | mfgData[0];
    if (companyId != _mfgCompanyId) return NexioDeviceState.unconfigured;

    final flags = mfgData[2];
    final cfg = (flags & _flagCfg) != 0;
    final wifi = (flags & _flagWifi) != 0;
    final svr = (flags & _flagSvr) != 0;
    final prd = (flags & _flagPrd) != 0;

    if (!cfg) return NexioDeviceState.unconfigured;
    if (cfg && !wifi) return NexioDeviceState.configuring;
    if (cfg && wifi && !svr) return NexioDeviceState.connecting;
    if (cfg && wifi && svr && prd) return NexioDeviceState.fullConnected;
    if (cfg && wifi && svr) return NexioDeviceState.connected;
    return NexioDeviceState.wifiOnly;
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
    buffer.write('"serverUrl":"${_escapeJson(config['serverUrl'] ?? '")');
    final uniqueId = config['uniqueId'];
    if (uniqueId != null && uniqueId.isNotEmpty) {
      buffer.write(',"uniqueId":"${_escapeJson(uniqueId)}"');
    }
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
    final uniqueId = config['uniqueId'];
    if (uniqueId != null && uniqueId.isNotEmpty) {
      buffer.write(',"uniqueId":"${_escapeJson(uniqueId)}"');
    }
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