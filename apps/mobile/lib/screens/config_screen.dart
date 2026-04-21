import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import '../ble/ble_scanner.dart';
import '../services/storage_service.dart';

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

  @override
  void initState() {
    super.initState();
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
    } catch (e) {
      setState(() {
        _statusMessage = 'Connection failed: $e';
      });
    }
  }

  Future<void> _sendConfig() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isConnecting = true;
      _statusMessage = 'Sending configuration...';
    });

    final config = {
      'ssid': _ssidController.text,
      'password': _passwordController.text,
      'serverUrl': _serverUrlController.text,
    };

    await _storageService.setServerUrl(_serverUrlController.text);

    try {
      final success = await _bleScanner.sendConfig(widget.device, config);

      if (success) {
        setState(() {
          _isSuccess = true;
          _statusMessage = 'Configuration sent successfully!';
        });
      } else {
        setState(() {
          _statusMessage = 'Failed to send configuration';
        });
      }
    } catch (e) {
      setState(() {
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
    widget.device.disconnect();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Configure WiFi'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
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
                    color: _isSuccess
                        ? Colors.green.shade50
                        : Colors.orange.shade50,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    _statusMessage!,
                    style: TextStyle(
                      color: _isSuccess
                          ? Colors.green.shade800
                          : Colors.orange.shade800,
                    ),
                  ),
                ),
              const SizedBox(height: 16),
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
            ],
          ),
        ),
      ),
    );
  }
}
