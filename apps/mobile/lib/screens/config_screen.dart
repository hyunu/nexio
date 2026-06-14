import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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

class _MenuRow extends StatelessWidget {
  final IconData icon;
  final String label;
  const _MenuRow({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Row(
      children: [
        Icon(icon, size: 20, color: cs.onSurfaceVariant),
        const SizedBox(width: 12),
        Text(label, style: TextStyle(fontSize: 14, color: cs.onSurface)),
      ],
    );
  }
}

class _ConfigScreenState extends State<ConfigScreen> {
  final _formKey = GlobalKey<FormState>();
  final _ssidController = TextEditingController();
  final _passwordController = TextEditingController();
  int _baudRate = 19200;

  final BleScanner _bleScanner = BleScanner();
  final StorageService _storageService = StorageService();

  bool _isConnecting = false;
  bool _isConnected = false;
  String? _statusMessage;
  String? _wifiMac;
  OnboardingStage _stage = OnboardingStage.form;
  Map<String, String> _wifiProfiles = {};
  Timer? _pollTimer;
  StreamSubscription<String>? _logSubscription;
  final List<_LogEntry> _bleLogs = [];

  @override
  void initState() {
    super.initState();
    _loadWifiProfiles();
    _connectToDevice();
    widget.device.connectionState.listen((state) {
      if (mounted) {
        setState(() {
          _isConnected = state == BluetoothConnectionState.connected;
          if (state == BluetoothConnectionState.disconnected) {
            _statusMessage = 'Device disconnected';
          }
        });
      }
    });
  }

  Future<void> _connectToDevice() async {
    setState(() {
      _statusMessage = 'Connecting to device...';
    });

    try {
      await widget.device.connect(timeout: const Duration(seconds: 10));
      setState(() {
        _isConnected = true;
        _statusMessage = 'Connected. Enter WiFi details.';
      });
      _subscribeToBleLogs();
      _readWifiMac();
    } catch (e) {
      setState(() {
        _isConnected = false;
        _statusMessage = 'Connection failed: $e';
      });
    }
  }

  Future<void> _readWifiMac() async {
    final mac = await _bleScanner.readWifiMac(widget.device);
    if (mounted) {
      setState(() {
        _wifiMac = mac;
      });
    }
  }

  Future<void> _subscribeToBleLogs() async {
    try {
      final logStream = _bleScanner.subscribeToLogs(widget.device);
      _logSubscription = logStream.listen((message) {
        if (!mounted) return;
        String level = 'info';
        if (message.contains('FAILED') || message.contains('Error') || message.contains('timeout')) {
          level = 'error';
        } else if (message.contains('retrying') || message.contains('not found') || message.contains('Wrong password')) {
          level = 'error';
        }
        setState(() {
          _bleLogs.add(_LogEntry(
            timestamp: DateTime.now(),
            level: level,
            message: message.trim(),
          ));
        });
      });
    } catch (e) {
      // BLE log subscription failed silently
    }
  }

  Future<void> _loadWifiProfiles() async {
    final profiles = await _storageService.getWifiProfiles();
    final lastSsid = await _storageService.getLastWifiSsid();
    if (!mounted) return;
    setState(() {
      _wifiProfiles = profiles;
      if (lastSsid != null && profiles.containsKey(lastSsid)) {
        _ssidController.text = lastSsid;
        _passwordController.text = profiles[lastSsid]!;
      } else {
        _ssidController.text = "hyunu_2.4Ghz";
        _passwordController.text = "gusdn1006";
      }
    });
  }

  void _selectProfile(String ssid) {
    final pw = _wifiProfiles[ssid];
    if (pw == null) return;
    setState(() {
      _ssidController.text = ssid;
      _passwordController.text = pw;
    });
  }

  Future<void> _sendConfig() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isConnecting = true;
      _stage = OnboardingStage.sending;
      _statusMessage = 'Claiming board ID from server...';
    });

    final serverService = ServerService(widget.serverUrl);
    final macAddress = widget.device.remoteId.str.toUpperCase();

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
      'serverUrl': widget.serverUrl,
      'uniqueId': uniqueId,
      'baudRate': _baudRate,
    };

    await _storageService.setServerUrl(widget.serverUrl);

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

      await _storageService.saveWifiProfile(_ssidController.text, _passwordController.text);
      if (!mounted) return;
      setState(() {
        _wifiProfiles[_ssidController.text] = _passwordController.text;
      });

      final result = await serverService.waitForOnboarding(
        macAddress: macAddress,
      );

      if (result['registered'] == true) {
        setState(() {
          _stage = OnboardingStage.completed;
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

  Future<void> _sendCommand(String action) async {
    final confirm = await showDialog<bool>(
      context: context,
      useSafeArea: true,
      builder: (ctx) => Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Dialog(
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            backgroundColor: Colors.transparent,
            child: SingleChildScrollView(
              child: Container(
                padding: const EdgeInsets.all(24),
                decoration: BoxDecoration(
                  color: Theme.of(ctx).colorScheme.surface,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 56, height: 56,
                      decoration: BoxDecoration(
                        color: action == 'RESET'
                            ? Colors.orange.withValues(alpha: 0.1)
                            : Colors.red.withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: Icon(
                        action == 'RESET' ? Icons.restart_alt_rounded : Icons.delete_outline_rounded,
                        color: action == 'RESET' ? Colors.orange.shade600 : Colors.red.shade600,
                        size: 28,
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      action == 'RESET' ? 'Reset Board' : 'Discard Board',
                      style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      action == 'RESET'
                          ? 'This will restart the board.'
                          : 'This will erase all config and restart the board.',
                      style: TextStyle(fontSize: 14, color: Theme.of(ctx).colorScheme.onSurfaceVariant),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 24),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () => Navigator.pop(ctx, false),
                            style: OutlinedButton.styleFrom(
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                              padding: const EdgeInsets.symmetric(vertical: 14),
                            ),
                            child: const Text('Cancel'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: FilledButton(
                            onPressed: () => Navigator.pop(ctx, true),
                            style: FilledButton.styleFrom(
                              backgroundColor: action == 'RESET' ? Colors.orange.shade600 : Colors.red.shade600,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                              padding: const EdgeInsets.symmetric(vertical: 14),
                            ),
                            child: Text(action == 'RESET' ? 'Reset' : 'Discard'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    if (confirm != true) return;

    setState(() {
      _statusMessage = 'Sending $action command...';
    });

    try {
      final success = await _bleScanner.sendCommand(widget.device, action);
      if (success) {
        setState(() {
          _statusMessage = 'Command sent. Cleaning up server...';
        });

        if (action == 'DISCARD') {
          await Future.delayed(const Duration(milliseconds: 300));
          final serverService = ServerService(widget.serverUrl);
          await serverService.discardByMac(widget.device.remoteId.str.toUpperCase());
          widget.device.disconnect();
          _bleScanner.clearCache();
          if (mounted) Navigator.pop(context);
          return;
        }
      } else {
        setState(() {
          _statusMessage = 'Failed to send command';
        });
      }
    } catch (e) {
      setState(() {
        _statusMessage = 'Error: $e';
      });
    }
  }

  @override
  void dispose() {
    _ssidController.dispose();
    _passwordController.dispose();
    _pollTimer?.cancel();
    _logSubscription?.cancel();
    widget.device.disconnect();
    _bleScanner.clearCache();
    super.dispose();
  }

  void _showServerSettings() {
    final controller = TextEditingController(text: widget.serverUrl);
    final cs = Theme.of(context).colorScheme;
    showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Row(
          children: [
            Container(
              width: 36, height: 36,
              decoration: BoxDecoration(color: cs.primaryContainer, borderRadius: BorderRadius.circular(10)),
              child: Icon(Icons.dns_outlined, size: 20, color: cs.onPrimaryContainer),
            ),
            const SizedBox(width: 12),
            const Text('Server URL'),
          ],
        ),
        content: SizedBox(
          width: 320,
          child: TextField(
            controller: controller,
            autofocus: true,
            style: TextStyle(fontSize: 14, fontFamily: 'monospace', color: cs.onSurface),
            decoration: InputDecoration(
              hintText: 'http://192.168.0.9:10008',
              hintStyle: TextStyle(color: cs.onSurfaceVariant.withValues(alpha: 0.4), fontSize: 13),
              filled: true,
              fillColor: cs.surfaceContainerHighest.withValues(alpha: 0.5),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
              contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            ),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: Text('Cancel', style: TextStyle(color: cs.onSurfaceVariant))),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text),
            style: FilledButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }

  void _showDeviceInfo() {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        final cs = Theme.of(ctx).colorScheme;
        return Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(child: Container(width: 36, height: 4, decoration: BoxDecoration(color: cs.onSurfaceVariant.withValues(alpha: 0.2), borderRadius: BorderRadius.circular(2)))),
              const SizedBox(height: 12),
              Text('Device Info', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: cs.onSurface)),
              const SizedBox(height: 10),
              _buildCompactInfoRow(cs, widget.device.remoteId.str, _wifiMac),
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(color: cs.surfaceContainerLow, borderRadius: BorderRadius.circular(10)),
                child: Row(
                  children: [
                    Icon(Icons.dns_outlined, size: 14, color: cs.onSurfaceVariant),
                    const SizedBox(width: 6),
                    Expanded(child: Text(widget.serverUrl, style: TextStyle(fontSize: 12, fontFamily: 'monospace', color: cs.onSurface), overflow: TextOverflow.ellipsis)),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: () => Navigator.pop(ctx),
                  style: OutlinedButton.styleFrom(
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                  ),
                  child: const Text('Close'),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final showLogPanel = _stage == OnboardingStage.sending || _stage == OnboardingStage.waiting;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Configure Module'),
        backgroundColor: cs.surfaceContainerHighest,
        actions: [
          PopupMenuButton<String>(
            icon: Icon(Icons.more_vert, color: cs.onSurface),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            elevation: 2,
            onSelected: (v) {
              if (v == 'info') _showDeviceInfo();
              if (v == 'server') _showServerSettings();
              if (v == 'reset') _sendCommand('RESET');
              if (v == 'discard') _sendCommand('DISCARD');
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'info', child: _MenuRow(icon: Icons.info_outline, label: 'Device Info')),
              const PopupMenuItem(value: 'server', child: _MenuRow(icon: Icons.dns_outlined, label: 'Server')),
              PopupMenuDivider(height: 8),
              const PopupMenuItem(value: 'reset', child: _MenuRow(icon: Icons.restart_alt, label: 'Reset')),
              const PopupMenuItem(value: 'discard', child: _MenuRow(icon: Icons.factory_outlined, label: 'Discard')),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _buildDeviceInfoCard(cs),
                  const SizedBox(height: 16),
                  if (_stage == OnboardingStage.form) ...[
                    _buildWiFiForm(cs),
                    const SizedBox(height: 16),
                    _buildSendButton(cs),
                  ],
                  if (showLogPanel) ...[
                    if (_statusMessage != null) _buildStatusCard(cs),
                    const SizedBox(height: 12),
                    _buildBleLogPanel(cs),
                  ],
                  if (_stage == OnboardingStage.completed || _stage == OnboardingStage.failed) ...[
                    _buildStatusCard(cs),
                    const SizedBox(height: 16),
                    _buildDoneButton(cs),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDeviceInfoCard(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLow,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Container(
            width: 40, height: 40,
            decoration: BoxDecoration(
              color: cs.primaryContainer,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(Icons.bluetooth, size: 20, color: cs.onPrimaryContainer),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              widget.device.platformName.isNotEmpty ? widget.device.platformName : 'Nexio Device',
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: cs.onSurface),
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: _isConnected ? Colors.green.withValues(alpha: 0.1) : Colors.orange.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(width: 5, height: 5, decoration: BoxDecoration(color: _isConnected ? Colors.green : Colors.orange, shape: BoxShape.circle)),
                const SizedBox(width: 4),
                Text(
                  _isConnected ? 'Connected' : 'Connecting...',
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.w500, color: _isConnected ? Colors.green.shade700 : Colors.orange.shade700),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCompactInfoRow(ColorScheme cs, String bleUuid, String? wifiMac) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLow,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              SizedBox(width: 64, child: Text('BLE UUID', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: cs.onSurfaceVariant.withValues(alpha: 0.5)))),
              Expanded(child: Text(bleUuid, style: TextStyle(fontSize: 13, fontFamily: 'monospace', color: cs.onSurface), overflow: TextOverflow.ellipsis)),
              GestureDetector(
                onTap: () {
                  Clipboard.setData(ClipboardData(text: bleUuid));
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('BLE UUID copied'), duration: Duration(seconds: 1), behavior: SnackBarBehavior.floating));
                },
                child: Padding(padding: const EdgeInsets.only(left: 4), child: Icon(Icons.copy_rounded, size: 16, color: cs.primary)),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              SizedBox(width: 64, child: Text('WiFi MAC', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: cs.onSurfaceVariant.withValues(alpha: 0.5)))),
              Expanded(child: Text(wifiMac ?? 'Loading...', style: TextStyle(fontSize: 13, fontFamily: 'monospace', color: cs.onSurface), overflow: TextOverflow.ellipsis)),
              if (wifiMac != null)
                GestureDetector(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: wifiMac));
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('WiFi MAC copied'), duration: Duration(seconds: 1), behavior: SnackBarBehavior.floating));
                  },
                  child: Padding(padding: const EdgeInsets.only(left: 4), child: Icon(Icons.copy_rounded, size: 16, color: cs.primary)),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildProfileSelector(ColorScheme cs) {
    final entries = _wifiProfiles.entries.toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Text('Saved Networks', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w500, color: cs.onSurfaceVariant)),
        ),
        Wrap(
          spacing: 6,
          runSpacing: 4,
          children: entries.map((e) {
            final active = _ssidController.text == e.key;
            return ActionChip(
              avatar: Icon(Icons.wifi, size: 14, color: active ? cs.onPrimaryContainer : cs.onSurfaceVariant),
              label: Text(e.key, style: TextStyle(fontSize: 12, color: active ? cs.onPrimaryContainer : cs.onSurface)),
              onPressed: () => _selectProfile(e.key),
              backgroundColor: active ? cs.primaryContainer : cs.surfaceContainerHighest,
              side: active ? BorderSide(color: cs.primary, width: 1) : BorderSide.none,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
              padding: const EdgeInsets.symmetric(horizontal: 2),
            );
          }).toList(),
        ),
      ],
    );
  }

  Widget _buildWiFiForm(ColorScheme cs) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_wifiProfiles.isNotEmpty) ...[
          _buildProfileSelector(cs),
          const SizedBox(height: 12),
        ],
        Text(
          'WiFi Credentials',
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: cs.onSurfaceVariant),
        ),
        const SizedBox(height: 10),
        Form(
          key: _formKey,
          child: Column(
            children: [
              TextFormField(
                controller: _ssidController,
                style: TextStyle(fontSize: 15, color: cs.onSurface),
                decoration: InputDecoration(
                  hintText: 'Enter WiFi name',
                  hintStyle: TextStyle(color: cs.onSurfaceVariant.withValues(alpha: 0.4)),
                  prefixIcon: Icon(Icons.wifi, size: 20, color: cs.primary),
                  filled: true,
                  fillColor: cs.surfaceContainerHighest.withValues(alpha: 0.5),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: BorderSide.none,
                  ),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                ),
                validator: (value) {
                  if (value == null || value.isEmpty) return 'Please enter WiFi SSID';
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _passwordController,
                obscureText: true,
                style: TextStyle(fontSize: 15, color: cs.onSurface),
                decoration: InputDecoration(
                  hintText: 'Enter WiFi password',
                  hintStyle: TextStyle(color: cs.onSurfaceVariant.withValues(alpha: 0.4)),
                  prefixIcon: Icon(Icons.lock_outline, size: 20, color: cs.primary),
                  filled: true,
                  fillColor: cs.surfaceContainerHighest.withValues(alpha: 0.5),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: BorderSide.none,
                  ),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                ),
                validator: (value) {
                  if (value == null || value.isEmpty) return 'Please enter WiFi password';
                  return null;
                },
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        Text(
          'Serial Baud Rate',
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: cs.onSurfaceVariant),
        ),
        const SizedBox(height: 8),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
            borderRadius: BorderRadius.circular(12),
          ),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<int>(
              value: _baudRate,
              isExpanded: true,
              dropdownColor: cs.surfaceContainerHighest,
              style: TextStyle(fontSize: 15, color: cs.onSurface),
              items: [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) {
                return DropdownMenuItem<int>(value: b, child: Text('$b bps'));
              }).toList(),
              onChanged: (v) {
                if (v != null) setState(() => _baudRate = v);
              },
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildSendButton(ColorScheme cs) {
    return SizedBox(
      height: 50,
      child: FilledButton.icon(
        onPressed: (_isConnecting || !_isConnected) ? null : _sendConfig,
        icon: _isConnecting
            ? const SizedBox(
                width: 20, height: 20,
                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
              )
            : const Icon(Icons.send_rounded, size: 20),
        label: Text(_isConnecting ? 'Sending...' : 'Send Configuration'),
        style: FilledButton.styleFrom(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
      ),
    );
  }

  Widget _buildStatusCard(ColorScheme cs) {
    final isCompleted = _stage == OnboardingStage.completed;
    final isFailed = _stage == OnboardingStage.failed;
    final isWaiting = _stage == OnboardingStage.waiting;
    final Color bgColor;
    final Color iconColor;
    final IconData iconData;

    if (isCompleted) {
      bgColor = Colors.green.shade50;
      iconColor = Colors.green.shade600;
      iconData = Icons.check_circle_rounded;
    } else if (isFailed) {
      bgColor = Colors.red.shade50;
      iconColor = Colors.red.shade600;
      iconData = Icons.error_outline_rounded;
    } else if (isWaiting) {
      bgColor = Colors.blue.shade50;
      iconColor = Colors.blue.shade600;
      iconData = Icons.hourglass_top_rounded;
    } else {
      bgColor = Colors.blue.shade50;
      iconColor = Colors.blue.shade600;
      iconData = Icons.info_outline_rounded;
    }

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (isWaiting)
            SizedBox(
              width: 20, height: 20,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: iconColor,
              ),
            )
          else
            Icon(iconData, color: iconColor, size: 24),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              _statusMessage ?? '',
              style: TextStyle(
                fontSize: 13,
                color: iconColor.withValues(alpha: 0.9),
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBleLogPanel(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.8),
        borderRadius: BorderRadius.circular(12),
      ),
      constraints: const BoxConstraints(maxHeight: 200),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Board Logs',
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: cs.onSurfaceVariant.withValues(alpha: 0.6),
            ),
          ),
          const SizedBox(height: 6),
          Expanded(
            child: _bleLogs.isEmpty
                ? Center(
                    child: Text(
                      'Waiting for board logs...',
                      style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant.withValues(alpha: 0.4)),
                    ),
                  )
                : ListView.builder(
                    itemCount: _bleLogs.length,
                    itemBuilder: (context, index) {
                      final log = _bleLogs[index];
                      final time = '${log.timestamp.hour.toString().padLeft(2, '0')}:'
                          '${log.timestamp.minute.toString().padLeft(2, '0')}:'
                          '${log.timestamp.second.toString().padLeft(2, '0')}';
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 1),
                        child: Text.rich(
                          TextSpan(
                            children: [
                              TextSpan(
                                text: '$time ',
                                style: TextStyle(
                                  color: cs.onSurfaceVariant.withValues(alpha: 0.4),
                                  fontSize: 11,
                                  fontFamily: 'monospace',
                                ),
                              ),
                              TextSpan(
                                text: log.message,
                                style: TextStyle(
                                  color: log.level == 'error'
                                      ? Colors.red.shade400
                                      : Colors.green.shade600,
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
        ],
      ),
    );
  }

  Widget _buildDoneButton(ColorScheme cs) {
    final isCompleted = _stage == OnboardingStage.completed;
    return SizedBox(
      height: 50,
      child: FilledButton.icon(
        onPressed: () => Navigator.pop(context),
        icon: Icon(isCompleted ? Icons.check_rounded : Icons.close_rounded, size: 20),
        label: Text(isCompleted ? 'Done' : 'Close'),
        style: FilledButton.styleFrom(
          backgroundColor: isCompleted ? Colors.green.shade600 : Colors.red.shade600,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
      ),
    );
  }
}
