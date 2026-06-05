import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import '../ble/ble_scanner.dart';
import '../services/storage_service.dart';
import 'config_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final BleScanner _bleScanner = BleScanner();
  final StorageService _storageService = StorageService();

  List<ScanResult> _devices = [];
  bool _isScanning = false;
  String? _savedServerUrl;
  StreamSubscription? _scanSubscription;

  @override
  void initState() {
    super.initState();
    _loadSavedServerUrl();
    _startScan();
  }

  @override
  void dispose() {
    _scanSubscription?.cancel();
    _bleScanner.stopScan();
    super.dispose();
  }

  Future<void> _loadSavedServerUrl() async {
    final url = await _storageService.getServerUrl();
    setState(() {
      _savedServerUrl = url;
    });
  }

  Future<void> _startScan() async {
    if (!mounted) return;
    setState(() {
      _isScanning = true;
      _devices = [];
    });

    _scanSubscription?.cancel();
    _scanSubscription = _bleScanner.scanResults.listen((results) {
      if (!mounted) return;
      setState(() {
        _devices = results
            .where((r) {
              if (r.device.name.startsWith('Nexio')) return true;
              final mfg = r.advertisementData.manufacturerData;
              if (mfg.containsKey(0x02D5)) return true;
              final uuids = r.advertisementData.serviceUuids;
              if (uuids.any((u) => u.str.toLowerCase().contains('6e400001'))) return true;
              return false;
            })
            .toList();
      });
    });

    try {
      await _bleScanner.startScan(timeout: const Duration(seconds: 10));
    } catch (e) {
      debugPrint('Scan start failed: $e');
      _scanSubscription?.cancel();
      if (mounted) {
        setState(() => _isScanning = false);
      }
      return;
    }

    await Future.delayed(const Duration(seconds: 10));

    if (!mounted) return;
    setState(() {
      _isScanning = false;
    });
  }

  static const _stateColors = {
    NexioDeviceState.unconfigured: Colors.grey,
    NexioDeviceState.configuring: Colors.orange,
    NexioDeviceState.connecting: Colors.orange,
    NexioDeviceState.connected: Colors.yellow,
    NexioDeviceState.fullConnected: Colors.green,
    NexioDeviceState.wifiOnly: Colors.red,
  };

  static const _stateLabels = {
    NexioDeviceState.unconfigured: 'Unconfigured',
    NexioDeviceState.configuring: 'Configuring',
    NexioDeviceState.connecting: 'Connecting',
    NexioDeviceState.connected: 'Connected',
    NexioDeviceState.fullConnected: 'Active',
    NexioDeviceState.wifiOnly: 'WiFi only',
  };

  void _onDeviceSelected(ScanResult device) {
    final state = BleScanner.parseStateFromAdData(device.advertisementData);
    if (state != NexioDeviceState.connected && state != NexioDeviceState.fullConnected) {
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (context) => ConfigScreen(
            device: device.device,
            serverUrl: _savedServerUrl ?? 'ws://192.168.1.100:10008/ws/board',
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Nexio Setup'),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    _isScanning ? 'Scanning for devices...' : 'Select your device',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                if (_isScanning)
                  const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else
                  IconButton(
                    icon: const Icon(Icons.refresh),
                    onPressed: _startScan,
                  ),
              ],
            ),
          ),
          if (_savedServerUrl != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16.0),
              child: Text(
                'Saved Server: $_savedServerUrl',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          Expanded(
            child: _devices.isEmpty
                ? Center(
                    child: Text(
                      _isScanning
                          ? 'Searching...'
                          : 'No Nexio devices found',
                      style: Theme.of(context).textTheme.bodyLarge,
                    ),
                  )
                : ListView.builder(
                    itemCount: _devices.length,
                    itemBuilder: (context, index) {
                      final device = _devices[index];
                      final state = BleScanner.parseStateFromAdData(
                        device.advertisementData,
                      );
                      final color = _stateColors[state] ?? Colors.grey;
                      final label = _stateLabels[state] ?? '';
                      final canTap = state == NexioDeviceState.unconfigured || state == NexioDeviceState.configuring || state == NexioDeviceState.wifiOnly;
                      return ListTile(
                        leading: CircleAvatar(
                          backgroundColor: color,
                          radius: 14,
                          child: Icon(
                            Icons.bluetooth,
                            size: 16,
                            color: Colors.white,
                          ),
                        ),
                        title: Text(device.device.name),
                        subtitle: Text('${device.device.id.id} · $label'),
                        trailing: canTap
                            ? const Icon(Icons.settings)
                            : const Icon(Icons.arrow_forward_ios),
                        onTap: canTap ? () => _onDeviceSelected(device) : null,
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
