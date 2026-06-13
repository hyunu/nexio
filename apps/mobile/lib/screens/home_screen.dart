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
    try {
      await FlutterBluePlus.stopScan();
    } catch (_) {}

    _scanSubscription = _bleScanner.scanResults.listen((results) {
      if (!mounted) return;
      setState(() {
        _devices = results
            .where((r) {
              final advName = r.device.platformName.isNotEmpty ? r.device.platformName : r.advertisementData.advName;
      if (advName.startsWith('Nexio')) return true;
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
    NexioDeviceState.unconfigured: Color(0xFF78909C),
    NexioDeviceState.configuring: Color(0xFFFFB300),
    NexioDeviceState.connecting: Color(0xFFFF6D00),
    NexioDeviceState.connected: Color(0xFF2979FF),
    NexioDeviceState.fullConnected: Color(0xFF00C853),
    NexioDeviceState.wifiOnly: Color(0xFFFF1744),
  };

  static const _stateLabels = {
    NexioDeviceState.unconfigured: 'Unconfigured',
    NexioDeviceState.configuring: 'Configuring',
    NexioDeviceState.connecting: 'Connecting',
    NexioDeviceState.connected: 'Connected',
    NexioDeviceState.fullConnected: 'Active',
    NexioDeviceState.wifiOnly: 'WiFi only',
  };

  static const _stateIcons = {
    NexioDeviceState.unconfigured: Icons.bluetooth,
    NexioDeviceState.configuring: Icons.bluetooth,
    NexioDeviceState.connecting: Icons.bluetooth,
    NexioDeviceState.connected: Icons.bluetooth_connected,
    NexioDeviceState.fullConnected: Icons.check_circle,
    NexioDeviceState.wifiOnly: Icons.wifi_off,
  };

  void _onDeviceSelected(ScanResult device) async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => ConfigScreen(
          device: device.device,
          serverUrl: _savedServerUrl ?? 'http://192.168.0.142:10008',
        ),
      ),
    );
    if (mounted) _startScan();
  }

  Future<void> _showServerSettings() async {
    final controller = TextEditingController(text: _savedServerUrl ?? 'http://192.168.0.142:10008');
    final cs = Theme.of(context).colorScheme;
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Row(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: cs.primaryContainer,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(Icons.dns_outlined, size: 20, color: cs.onPrimaryContainer),
            ),
            const SizedBox(width: 12),
            const Text('Server URL'),
          ],
        ),
        content: TextField(
          controller: controller,
          autofocus: true,
          style: TextStyle(fontSize: 14, fontFamily: 'monospace', color: cs.onSurface),
          decoration: InputDecoration(
            hintText: 'http://192.168.0.9:10008',
            hintStyle: TextStyle(color: cs.onSurfaceVariant.withValues(alpha: 0.4), fontSize: 13),
            filled: true,
            fillColor: cs.surfaceContainerHighest.withValues(alpha: 0.5),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: BorderSide.none,
            ),
            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('Cancel', style: TextStyle(color: cs.onSurfaceVariant)),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text),
            style: FilledButton.styleFrom(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            ),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (result != null && result.isNotEmpty) {
      await _storageService.setServerUrl(result);
      setState(() {
        _savedServerUrl = result;
      });
    }
  }

  Widget _buildRssiIndicator(int rssi) {
    final int bars;
    final Color barColor;
    if (rssi >= -55) {
      bars = 4;
      barColor = const Color(0xFF00C853);
    } else if (rssi >= -65) {
      bars = 3;
      barColor = const Color(0xFF69F0AE);
    } else if (rssi >= -75) {
      bars = 2;
      barColor = const Color(0xFFFFB300);
    } else if (rssi >= -85) {
      bars = 1;
      barColor = const Color(0xFFFF6D00);
    } else {
      bars = 0;
      barColor = const Color(0xFFFF1744);
    }

    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: List.generate(4, (i) {
        final height = 5.0 + i * 3.0;
        return Container(
          width: 3.5,
          height: height,
          margin: const EdgeInsets.only(right: 2.5),
          decoration: BoxDecoration(
            color: i < bars ? barColor : Colors.grey.shade300,
            borderRadius: BorderRadius.circular(2),
          ),
        );
      }),
    );
  }

  Widget _buildDeviceCard(ScanResult device) {
    final state = BleScanner.parseStateFromAdData(
      device.advertisementData,
    );
    final color = _stateColors[state] ?? Colors.grey;
    final label = _stateLabels[state] ?? '';
    final icon = _stateIcons[state] ?? Icons.bluetooth;
    final cs = Theme.of(context).colorScheme;

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: cs.outlineVariant, width: 0.5),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => _onDeviceSelected(device),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, color: color, size: 22),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      device.device.platformName.isNotEmpty ? device.device.platformName : device.advertisementData.advName,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        height: 1.2,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      device.device.remoteId.str,
                      style: TextStyle(
                        fontSize: 12,
                        fontFamily: 'monospace',
                        color: cs.onSurfaceVariant.withValues(alpha: 0.6),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisSize: MainAxisSize.min,
                children: [
                  _buildRssiIndicator(device.rssi),
                  const SizedBox(height: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      label,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: color,
                        height: 1.2,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(width: 4),
              Icon(Icons.chevron_right, size: 18, color: cs.onSurfaceVariant.withValues(alpha: 0.3)),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Nexio Setup'),
        backgroundColor: cs.surfaceContainerHighest,
        actions: [
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: _showServerSettings,
          ),
        ],
      ),
      body: Column(
        children: [
          Container(
            height: 52,
            padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(
                  child: Text(
                    _devices.isEmpty
                        ? 'Scanning for devices...'
                        : '${_devices.length} device${_devices.length != 1 ? 's' : ''} found',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
                if (_isScanning)
                  _buildScanningIndicator(cs)
                else
                  IconButton(
                    icon: const Icon(Icons.refresh_rounded, size: 22),
                    onPressed: _startScan,
                    style: IconButton.styleFrom(
                      backgroundColor: cs.surfaceContainerHighest.withValues(alpha: 0.5),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 4),
          Expanded(
            child: _devices.isEmpty
                ? _buildEmptyState(cs)
                : ListView.builder(
                    padding: const EdgeInsets.only(top: 4, bottom: 20),
                    itemCount: _devices.length,
                    itemBuilder: (context, index) => _buildDeviceCard(_devices[index]),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildScanningIndicator(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: cs.primary.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(
              strokeWidth: 1.5,
              color: cs.primary,
            ),
          ),
          const SizedBox(width: 6),
          Text(
            'Scanning',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: cs.primary,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildEmptyState(ColorScheme cs) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Icon(
              _isScanning ? Icons.bluetooth_searching : Icons.bluetooth_disabled,
              size: 28,
              color: cs.onSurfaceVariant.withValues(alpha: 0.4),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            _isScanning ? 'Searching...' : 'No Nexio devices found',
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w500,
              color: cs.onSurfaceVariant.withValues(alpha: 0.8),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            _isScanning
                ? 'Make sure your board is powered on'
                : 'Tap refresh to scan again',
            style: TextStyle(
              fontSize: 13,
              color: cs.onSurfaceVariant.withValues(alpha: 0.5),
            ),
          ),
        ],
      ),
    );
  }
}
