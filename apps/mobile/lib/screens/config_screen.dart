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

class _DeviceButton extends StatelessWidget {
  const _DeviceButton({
    required this.enabled,
    required this.onPressed,
    required this.icon,
    required this.label,
    required this.color,
  });

  final bool enabled;
  final VoidCallback onPressed;
  final IconData icon;
  final String label;
  final MaterialColor color;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: enabled ? 1.0 : 0.35,
      child: AbsorbPointer(
        absorbing: !enabled,
        child: OutlinedButton.icon(
          onPressed: onPressed,
          icon: Icon(icon, size: 18),
          label: Text(label),
          style: OutlinedButton.styleFrom(
            foregroundColor: color.shade700,
            side: BorderSide(color: color.shade300),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            padding: const EdgeInsets.symmetric(vertical: 12),
          ),
        ),
      ),
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
    } catch (e) {
      setState(() {
        _isConnected = false;
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

  Future<void> _deleteProfile(String ssid) async {
    await _storageService.deleteWifiProfile(ssid);
    if (!mounted) return;
    setState(() {
      _wifiProfiles.remove(ssid);
      if (_ssidController.text == ssid) {
        _ssidController.text = '';
        _passwordController.text = '';
      }
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

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final showLogPanel = _stage == OnboardingStage.sending || _stage == OnboardingStage.waiting;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Configure WiFi'),
        backgroundColor: cs.surfaceContainerHighest,
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
                  if (_statusMessage != null && _stage == OnboardingStage.form)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: _buildStatusCard(cs),
                    ),
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
          if (_stage == OnboardingStage.form)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
              child: _buildDeviceControls(cs),
            ),
        ],
      ),
    );
  }

  Widget _buildDeviceInfoCard(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLow,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: cs.primaryContainer,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Icon(Icons.bluetooth, size: 24, color: cs.onPrimaryContainer),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  widget.device.platformName.isNotEmpty ? widget.device.platformName : 'Nexio Device',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: cs.onSurface),
                ),
                const SizedBox(height: 2),
                Text(
                  widget.device.remoteId.str,
                  style: TextStyle(fontSize: 12, fontFamily: 'monospace', color: cs.onSurfaceVariant),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(
              color: _isConnected
                  ? Colors.green.withValues(alpha: 0.1)
                  : Colors.orange.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: _isConnected ? Colors.green : Colors.orange,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 5),
                Text(
                  _isConnected ? 'Connected' : 'Connecting...',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w500,
                    color: _isConnected ? Colors.green.shade700 : Colors.orange.shade700,
                  ),
                ),
              ],
            ),
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
        Text(
          'Saved Networks',
          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: cs.onSurfaceVariant),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: entries.map((e) {
            final active = _ssidController.text == e.key;
            return Material(
              color: Colors.transparent,
              child: InkWell(
                borderRadius: BorderRadius.circular(20),
                onTap: () => _selectProfile(e.key),
                child: Container(
                  padding: const EdgeInsets.only(left: 12, right: 4, top: 4, bottom: 4),
                  decoration: BoxDecoration(
                    color: active ? cs.primaryContainer : cs.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(20),
                    border: active ? Border.all(color: cs.primary, width: 1.5) : null,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.wifi, size: 14, color: active ? cs.onPrimaryContainer : cs.onSurfaceVariant),
                      const SizedBox(width: 4),
                      Text(
                        e.key,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: active ? FontWeight.w600 : FontWeight.w400,
                          color: active ? cs.onPrimaryContainer : cs.onSurface,
                        ),
                      ),
                      const SizedBox(width: 2),
                      InkWell(
                        borderRadius: BorderRadius.circular(10),
                        onTap: () => _confirmDeleteProfile(e.key),
                        child: Padding(
                          padding: const EdgeInsets.all(4),
                          child: Icon(Icons.close, size: 14, color: cs.onSurfaceVariant),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          }).toList(),
        ),
      ],
    );
  }

  void _confirmDeleteProfile(String ssid) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Profile'),
        content: Text('Delete "$ssid" profile?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              _deleteProfile(ssid);
            },
            child: const Text('Delete', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
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
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: cs.tertiaryContainer.withValues(alpha: 0.4),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            children: [
              Icon(Icons.dns_outlined, size: 14, color: cs.onTertiaryContainer),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  widget.serverUrl,
                  style: TextStyle(
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: cs.onTertiaryContainer,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
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

  Widget _buildDeviceControls(ColorScheme cs) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const Expanded(child: Divider()),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: Text('Device Controls', style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant.withValues(alpha: 0.6))),
            ),
            const Expanded(child: Divider()),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: _DeviceButton(
                enabled: _isConnected && !_isConnecting,
                onPressed: () => _sendCommand('RESET'),
                icon: Icons.restart_alt,
                label: 'Reset',
                color: Colors.orange,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _DeviceButton(
                enabled: _isConnected && !_isConnecting,
                onPressed: () => _sendCommand('DISCARD'),
                icon: Icons.factory_outlined,
                label: 'Discard',
                color: Colors.red,
              ),
            ),
          ],
        ),
      ],
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
