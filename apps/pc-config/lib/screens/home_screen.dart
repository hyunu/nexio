import 'package:flutter/material.dart';
import 'package:flutter_web_bluetooth/flutter_web_bluetooth.dart';
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

  List<BluetoothDevice> _devices = [];
  bool _isScanning = false;
  String? _savedServerUrl;

  @override
  void initState() {
    super.initState();
    _loadSavedServerUrl();
    _startScan();
  }

  Future<void> _loadSavedServerUrl() async {
    final url = await _storageService.getServerUrl();
    setState(() {
      _savedServerUrl = url;
    });
  }

  Future<void> _startScan() async {
    setState(() {
      _isScanning = true;
      _devices = [];
    });

    try {
      final results = await _bleScanner.startScan();
      setState(() {
        _devices = results;
      });
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('BLE not available: $e')),
        );
      }
    }

    setState(() {
      _isScanning = false;
    });
  }

  void _onDeviceSelected(BluetoothDevice device) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => ConfigScreen(
          device: device,
          serverUrl: _savedServerUrl ?? 'ws://192.168.1.100:10008/ws/board',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Nexio Setup (Web)'),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _isScanning ? null : _startScan,
          ),
        ],
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
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        if (_isScanning)
                          const CircularProgressIndicator()
                        else
                          const Text('No Nexio devices found'),
                        const SizedBox(height: 16),
                        ElevatedButton(
                          onPressed: _startScan,
                          child: const Text('Scan Again'),
                        ),
                      ],
                    ),
                  )
                : ListView.builder(
                    itemCount: _devices.length,
                    itemBuilder: (context, index) {
                      final device = _devices[index];
                      return ListTile(
                        leading: const Icon(Icons.bluetooth),
                        title: Text(device.name.isNotEmpty ? device.name : 'Unknown Device'),
                        subtitle: Text(device.id),
                        trailing: const Icon(Icons.arrow_forward_ios),
                        onTap: () => _onDeviceSelected(device),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
