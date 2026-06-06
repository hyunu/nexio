import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import '../ble/ble_scanner.dart';
import '../services/storage_service.dart';
import '../services/server_service.dart';

enum OnboardingStage { form, sending, waiting, completed, failed }

class _LogEntry {
  final DateTime timestamp;
  final String level;
  final String message;

  _LogEntry({required this.timestamp, required this.level, required this.message});
}

class ConfigScreen extends StatefulWidget {
  final BluetoothDevice device;
  final String serverUrl;

  const ConfigScreen({
    super.key,
    required this.device,
    required this.serverUrl,
  });

  @override
  State<ConfigScreen> createState() => _ConfigScreenState();
}

class _ConfigScreenState extends State<ConfigScreen> {
  final _formKey = GlobalKey<FormState>();
  final _ssidController = TextEditingController();
  final _passwordController = TextEditingController();
  final _serverUrlController = TextEditingController();

  final BleScanner _bleScanner = BleScanner();
  final StorageService _storageService = StorageService();

  bool _isConnecting = false;
  String? _statusMessage;
  bool _isSuccess = false;
  OnboardingStage _stage = OnboardingStage.form;
  String? _boardUniqueId;
  Timer? _pollTimer;
  StreamSubscription<String>? _logSubscription;
  final List<_LogEntry> _bleLogs = [];

  @override
  void initState() {
    super.initState();
    _ssidController.text = "hyunu_2.4Ghz";
    _passwordController.text = "gusdn1006";
    _serverUrlController.text = widget.serverUrl;
    _connectToDevice();
  }

  Future<void> _connectToDevice() async {
    setState(() {
      _statusMessage = 'Connecting to device...';
    });

    try {
      await widget.device.connect(timeout: const Duration(seconds: 10));
      setState(() {
        _statusMessage = 'Connected. Enter WiFi details.';
      });
      _subscribeToBleLogs();
    } catch (e) {
      setState(() {
        _statusMessage = 'Connection failed: $e';
      });
    }
  }

  Future<void> _subscribeToBleLogs() async {
    try {
      final logStream = _bleScanner.subscribeToLogs(widget.device);
      _logSubscription = logStream.listen((message) {
        if (!mounted) return;
        String level = 'info';
        String display = message;
        if (message.contains('FAILED') || message.contains('Error') || message.contains('timeout')) {
          level = 'error';
        } else if (message.contains('retrying') || message.contains('not found') || message.contains('Wrong password')) {
          level = 'error';
        }
        setState(() {
          _bleLogs.add(_LogEntry(
            timestamp: DateTime.now(),
            level: level,
            message: display.trim(),
          ));
        });
      });
    } catch (e) {
      // BLE log subscription failed silently
    }
  }

  Future<void> _sendConfig() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isConnecting = true;
      _stage = OnboardingStage.sending;
      _statusMessage = 'Claiming board ID from server...';
    });

    final serverService = ServerService(_serverUrlController.text);
    final macAddress = widget.device.id.id.toUpperCase();

    String? uniqueId;
    try {
      final claimResult = await serverService.claimUniqueId(macAddress);
      if (claimResult.containsKey('uniqueId')) {
        uniqueId = claimResult['uniqueId'] as String;
      } else {
        setState(() {
          _stage = OnboardingStage.failed;
          _isConnecting = false;
          _statusMessage = 'Failed to get board ID from server';
        });
        return;
      }
    } catch (e) {
      setState(() {
        _stage = OnboardingStage.failed;
        _isConnecting = false;
        _statusMessage = 'Server connection failed: $e';
      });
      return;
    }

    setState(() {
      _statusMessage = 'Sending configuration...\nBoard ID: $uniqueId';
    });

    final config = {
      'ssid': _ssidController.text,
      'password': _passwordController.text,
      'serverUrl': _serverUrlController.text,
      'uniqueId': uniqueId!,
    };

    await _storageService.setServerUrl(_serverUrlController.text);

    try {
      final success = await _bleScanner.sendConfig(widget.device, config);

      if (!success) {
        setState(() {
          _stage = OnboardingStage.failed;
          _isConnecting = false;
          _statusMessage = 'Failed to send configuration via BLE';
        });
        return;
      }

      setState(() {
        _stage = OnboardingStage.waiting;
        _statusMessage = 'Configuration sent!\nWaiting for board $uniqueId to connect to server...';
      });

      final result = await serverService.waitForOnboarding(
        macAddress: macAddress,
      );

      if (result['registered'] == true) {
        final board = result['board'] as Map<String, dynamic>;
        setState(() {
          _stage = OnboardingStage.completed;
          _isSuccess = true;
          _boardUniqueId = board['uniqueId'] as String;
          _statusMessage = 'Onboarding complete!\nBoard $uniqueId is ready';
        });
      } else {
        setState(() {
          _stage = OnboardingStage.failed;
          _statusMessage = 'Board $uniqueId did not connect within 30 seconds.\nCheck WiFi credentials and try again.';
        });
      }
    } catch (e) {
      setState(() {
        _stage = OnboardingStage.failed;
        _statusMessage = 'Error: $e';
      });
    }

    setState(() {
      _isConnecting = false;
    });
  }

  @override
  void dispose() {
    _ssidController.dispose();
    _passwordController.dispose();
    _serverUrlController.dispose();
    _pollTimer?.cancel();
    _logSubscription?.cancel();
    widget.device.disconnect();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bool showLogPanel = _stage == OnboardingStage.sending || _stage == OnboardingStage.waiting || _stage == OnboardingStage.failed;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Configure WiFi'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: SingleChildScrollView(
                child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Device: ${widget.device.name}',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(
                'MAC: ${widget.device.id.id}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 24),
              TextFormField(
                controller: _ssidController,
                decoration: const InputDecoration(
                  labelText: 'WiFi SSID',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.wifi),
                ),
                validator: (value) {
                  if (value == null || value.isEmpty) {
                    return 'Please enter WiFi SSID';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _passwordController,
                decoration: const InputDecoration(
                  labelText: 'WiFi Password',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.lock),
                ),
                obscureText: true,
                validator: (value) {
                  if (value == null || value.isEmpty) {
                    return 'Please enter WiFi password';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _serverUrlController,
                decoration: const InputDecoration(
                  labelText: 'Server URL',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.cloud),
                  hintText: 'ws://192.168.1.100:10008/ws/board',
                ),
                validator: (value) {
                  if (value == null || value.isEmpty) {
                    return 'Please enter server URL';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 24),
              if (_statusMessage != null)
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: _stage == OnboardingStage.completed
                        ? Colors.green.shade50
                        : _stage == OnboardingStage.failed
                            ? Colors.red.shade50
                            : Colors.blue.shade50,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Column(
                    children: [
                      if (_stage == OnboardingStage.waiting)
                        const Padding(
                          padding: EdgeInsets.only(bottom: 8),
                          child: SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                        ),
                      if (_stage == OnboardingStage.completed)
                        Icon(Icons.check_circle, color: Colors.green.shade600, size: 40),
                      if (_stage == OnboardingStage.failed)
                        Icon(Icons.error, color: Colors.red.shade600, size: 40),
                      if (_stage == OnboardingStage.completed || _stage == OnboardingStage.failed)
                        const SizedBox(height: 8),
                      Text(
                        _statusMessage!,
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: _stage == OnboardingStage.completed
                              ? Colors.green.shade800
                              : _stage == OnboardingStage.failed
                                  ? Colors.red.shade800
                                  : Colors.blue.shade800,
                        ),
                      ),
                    ),
                    ],
                ),
              ),
            ],
          ),
        ),
      ),
      ),
      if (showLogPanel) const SizedBox(height: 8),
      if (showLogPanel)
        Expanded(
          child: Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: Colors.grey.shade900,
              borderRadius: BorderRadius.circular(8),
            ),
            child: _bleLogs.isEmpty
                ? const Center(
                    child: Text(
                      'Waiting for board logs...',
                      style: TextStyle(color: Colors.grey, fontSize: 12),
                    ),
                  )
                : ListView.builder(
                    itemCount: _bleLogs.length,
                    itemBuilder: (context, index) {
                      final log = _bleLogs[index];
                      final time =
                          '${log.timestamp.hour.toString().padLeft(2, '0')}:'
                          '${log.timestamp.minute.toString().padLeft(2, '0')}:'
                          '${log.timestamp.second.toString().padLeft(2, '0')}';
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 1),
                        child: Text.rich(
                          TextSpan(
                            children: [
                              TextSpan(
                                text: '$time ',
                                style: const TextStyle(
                                  color: Colors.grey,
                                  fontSize: 11,
                                  fontFamily: 'monospace',
                                ),
                              ),
                              TextSpan(
                                text: log.message,
                                style: TextStyle(
                                  color: log.level == 'error'
                                      ? Colors.red.shade300
                                      : Colors.green.shade300,
                                  fontSize: 11,
                                  fontFamily: 'monospace',
                                ),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
        ),
      ),
      const SizedBox(height: 8),
      if (_stage == OnboardingStage.form || _stage == OnboardingStage.sending)
        ElevatedButton.icon(
          onPressed: _isConnecting ? null : _sendConfig,
          icon: _isConnecting
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.send),
          label: Text(_isConnecting ? 'Sending...' : 'Send Configuration'),
          style: ElevatedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 16),
          ),
        ),
      if (_stage == OnboardingStage.completed || _stage == OnboardingStage.failed)
        ElevatedButton.icon(
          onPressed: () => Navigator.pop(context),
          icon: const Icon(Icons.check),
          label: const Text('Done'),
          style: ElevatedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 16),
            backgroundColor: _stage == OnboardingStage.completed
                ? Colors.green
                : Colors.red,
            foregroundColor: Colors.white,
          ),
        ),
    ],
  ),
  ),
);
}
}
}
