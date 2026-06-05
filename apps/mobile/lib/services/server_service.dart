import 'dart:convert';
import 'dart:io';

class ServerService {
  final String baseUrl;

  ServerService(String wsUrl) : baseUrl = _toHttpUrl(wsUrl);

  static String _toHttpUrl(String wsUrl) {
    return wsUrl
        .replaceFirst('wss://', 'https://')
        .replaceFirst('ws://', 'http://')
        .replaceFirst('/ws/board', '')
        .replaceFirst('/ws/client', '');
  }

  Future<Map<String, dynamic>> claimUniqueId(String macAddress) async {
    try {
      final client = HttpClient();
      client.connectionTimeout = const Duration(seconds: 5);
      final request = await client.postUrl(
        Uri.parse('$baseUrl/api/onboarding/claim'),
      );
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode({'macAddress': macAddress}));
      final response = await request.close();
      final body = await response.transform(utf8.decoder).join();
      client.close();
      return jsonDecode(body) as Map<String, dynamic>;
    } catch (e) {
      return {'error': e.toString()};
    }
  }

  Future<Map<String, dynamic>> checkOnboarding(String macAddress) async {
    try {
      final client = HttpClient();
      client.connectionTimeout = const Duration(seconds: 5);
      final request = await client.getUrl(
        Uri.parse('$baseUrl/api/boards/onboarding?mac=$macAddress'),
      );
      final response = await request.close();
      final body = await response.transform(utf8.decoder).join();
      client.close();
      return jsonDecode(body) as Map<String, dynamic>;
    } catch (e) {
      return {'registered': false, 'error': e.toString()};
    }
  }

  Future<Map<String, dynamic>> waitForOnboarding({
    required String macAddress,
    Duration pollInterval = const Duration(seconds: 3),
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final deadline = DateTime.now().add(timeout);

    while (DateTime.now().isBefore(deadline)) {
      final result = await checkOnboarding(macAddress);
      if (result['registered'] == true) {
        return result;
      }
      await Future.delayed(pollInterval);
    }

    return {'registered': false, 'error': 'timeout'};
  }
}
