import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api.dart';

enum LiveState { connecting, live, offline }

/// Live availability over Server-Sent Events, with automatic reconnects.
///
/// [onReconnect] fires each time the stream comes back after a drop, so the screen can refetch
/// anything it missed while offline.
class LiveAvailability {
  LiveAvailability({
    required this.activityId,
    required this.onUpdate,
    required this.onState,
    this.onReconnect,
    this.onLatency,
  });

  final String activityId;
  final void Function(AvailabilityUpdate) onUpdate;
  final void Function(LiveState) onState;
  final void Function()? onReconnect;
  final void Function(AvailabilityUpdate, int latencyMs)? onLatency;

  http.Client? _client;
  StreamSubscription<String>? _sub;
  Timer? _retry;
  bool _closed = false;
  bool _wasConnected = false;
  int _attempt = 0;
  int _clockOffset = 0; // serverTime - phone time

  void start() => _connect();

  Future<void> _connect() async {
    if (_closed) return;
    onState(LiveState.connecting);
    _client?.close();
    final client = _client = http.Client();
    try {
      final req = http.Request('GET', Uri.parse('$apiUrl/stream?activityIds=$activityId'))
        ..headers['accept'] = 'text/event-stream';
      final res = await client.send(req).timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) throw Exception('stream ${res.statusCode}');

      var event = 'message';
      final data = StringBuffer();
      _sub = res.stream.transform(utf8.decoder).transform(const LineSplitter()).listen(
        (line) {
          if (line.isEmpty) {
            if (data.isNotEmpty) _handle(event, data.toString());
            event = 'message';
            data.clear();
          } else if (line.startsWith('event: ')) {
            event = line.substring(7);
          } else if (line.startsWith('data: ')) {
            data.write(line.substring(6));
          }
        },
        onDone: _scheduleReconnect,
        onError: (_) => _scheduleReconnect(),
        cancelOnError: true,
      );
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void _handle(String event, String raw) {
    final json = jsonDecode(raw) as Map<String, dynamic>;
    switch (event) {
      case 'hello':
        _clockOffset = (json['serverTime'] as int) - DateTime.now().millisecondsSinceEpoch;
        _attempt = 0;
        onState(LiveState.live);
        if (_wasConnected) onReconnect?.call();
        _wasConnected = true;
      case 'ping':
        _clockOffset = (json['serverTime'] as int) - DateTime.now().millisecondsSinceEpoch;
      case 'availability':
        final u = AvailabilityUpdate.fromJson(json);
        onUpdate(u);
        final latency = DateTime.now().millisecondsSinceEpoch + _clockOffset - u.committedAt;
        onLatency?.call(u, latency < 0 ? 0 : latency);
    }
  }

  void _scheduleReconnect() {
    if (_closed) return;
    onState(LiveState.offline);
    _sub?.cancel();
    // 1s, 2s, 4s… capped at 15s.
    final delay = Duration(seconds: [1 << _attempt, 15].reduce((a, b) => a < b ? a : b));
    _attempt = (_attempt + 1).clamp(0, 4);
    _retry?.cancel();
    _retry = Timer(delay, _connect);
  }

  void close() {
    _closed = true;
    _retry?.cancel();
    _sub?.cancel();
    _client?.close();
  }
}
