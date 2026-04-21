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

    _bleScanner.startScan(timeout: const Duration(seconds: 10));

    _bleScanner.scanResults.listen((results) {
      setState(() {
        _devices = results
            .where((r) => r.device.name.startsWith('Nexio'))
            .toList();
      });
    });

    await Future.delayed(const Duration(seconds: 10));

    setState(() {
      _isScanning = false;
    });
  }

  void _onDeviceSelected(ScanResult device) {
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
                      return ListTile(
                        leading: const Icon(Icons.bluetooth),
                        title: Text(device.device.name),
                        subtitle: Text(device.device.id.id),
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
