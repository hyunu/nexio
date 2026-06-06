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
  static const String _charNotifyUuid = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

  static const int _mfgCompanyId = 0x02D5;
  static const int _flagPrd = 0x01;
  static const int _flagSvr = 0x02;
  static const int _flagWifi = 0x04;
  static const int _flagCfg = 0x08;

  final StreamController<List<ScanResult>> _scanController =
      StreamController<List<ScanResult>>.broadcast();
  StreamSubscription<List<ScanResult>>? _fbpSubscription;

  Stream<List<ScanResult>> get scanResults => _scanController.stream;

  static NexioDeviceState parseStateFromAdData(AdvertisementData data) {
    final mfgMap = data.manufacturerData;
    if (mfgMap.isEmpty) {
      return NexioDeviceState.unconfigured;
    }

    final mfgData = mfgMap[_mfgCompanyId];
    if (mfgData == null || mfgData.length < 1) {
      return NexioDeviceState.unconfigured;
    }

    final flags = mfgData[0];
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
    _fbpSubscription?.cancel();

    await FlutterBluePlus.startScan(
      timeout: timeout,
    );

    _fbpSubscription = FlutterBluePlus.scanResults.listen((results) {
      _scanController.add(results);
    });
  }

  Future<void> stopScan() async {
    _fbpSubscription?.cancel();
    _fbpSubscription = null;
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

  Stream<String> subscribeToLogs(BluetoothDevice device) async* {
    List<BluetoothService> services = await device.discoverServices();
    for (var service in services) {
      if (service.uuid.str.toLowerCase() == _serviceUuid.toLowerCase()) {
        for (var characteristic in service.characteristics) {
          if (characteristic.uuid.str.toLowerCase() ==
              _charNotifyUuid.toLowerCase()) {
            await characteristic.setNotifyValue(true);
            yield* characteristic.onValueReceived.transform(
              StreamTransformer<List<int>, String>.fromHandlers(
                handleData: (data, sink) {
                  sink.add(String.fromCharCodes(data));
                },
              ),
            );
            return;
          }
        }
      }
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
