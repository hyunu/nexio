import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

class StorageService {
  static const String _serverUrlKey  = 'server_url';
  static const String _profilesKey   = 'wifi_profiles';
  static const String _lastSsidKey   = 'last_wifi_ssid';

  Future<String?> getServerUrl() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_serverUrlKey);
  }

  Future<void> setServerUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_serverUrlKey, url);
  }

  Future<void> clearServerUrl() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_serverUrlKey);
  }

  Future<Map<String, String>> getWifiProfiles() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_profilesKey);
    if (raw == null) return {};
    try {
      final decoded = json.decode(raw);
      if (decoded is Map) {
        return Map<String, String>.from(decoded);
      }
    } catch (_) {}
    await prefs.remove(_profilesKey);
    return {};
  }

  Future<void> saveWifiProfile(String ssid, String password) async {
    final prefs = await SharedPreferences.getInstance();
    final profiles = await getWifiProfiles();
    profiles[ssid] = password;
    await prefs.setString(_profilesKey, json.encode(profiles));
    await prefs.setString(_lastSsidKey, ssid);
  }

  Future<void> deleteWifiProfile(String ssid) async {
    final prefs = await SharedPreferences.getInstance();
    final profiles = await getWifiProfiles();
    profiles.remove(ssid);
    if (profiles.isEmpty) {
      await prefs.remove(_profilesKey);
    } else {
      await prefs.setString(_profilesKey, json.encode(profiles));
    }
  }

  Future<String?> getLastWifiSsid() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_lastSsidKey);
  }
}
