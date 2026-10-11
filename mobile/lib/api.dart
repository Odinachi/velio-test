import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'store.dart';

/// Backend base URL. Override with `--dart-define=API_URL=http://192.168.1.10:4000` on a device.
String get apiUrl {
  const fromEnv = String.fromEnvironment('API_URL');
  if (fromEnv.isNotEmpty) return fromEnv;
  // The Android emulator reaches the host machine through 10.0.2.2.
  return Platform.isAndroid ? 'http://10.0.2.2:4000' : 'http://localhost:4000';
}

/// Normalises what people type or paste: "velio://invite/abcd-1234", "ABCD 1234", a web link...
String normalizeCode(String raw) {
  var s = raw.trim();
  final match = RegExp(r'(?:invite/|/i/)([A-Za-z0-9-]+)').firstMatch(s);
  if (match != null) s = match.group(1)!;
  return s.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
}

class ApiException implements Exception {
  ApiException(this.status, this.code, this.message);
  final int status;
  final String code;
  final String message;

  /// Network trouble or a server error: retrying the same request may work.
  bool get retryable => status == 0 || status >= 500;
  bool get offline => status == 0;

  @override
  String toString() => '$code: $message';
}

class Activity {
  Activity({
    required this.id,
    required this.title,
    required this.description,
    required this.location,
    required this.startsAt,
    required this.priceCents,
    required this.currency,
    required this.capacity,
    required this.spotsTaken,
    required this.version,
    required this.hostName,
    required this.hasStarted,
  });

  factory Activity.fromJson(Map<String, dynamic> j) => Activity(
        id: j['id'] as String,
        title: j['title'] as String,
        description: j['description'] as String? ?? '',
        location: j['location'] as String? ?? '',
        startsAt: DateTime.parse(j['startsAt'] as String).toLocal(),
        priceCents: j['priceCents'] as int,
        currency: j['currency'] as String? ?? 'USD',
        capacity: j['capacity'] as int,
        spotsTaken: j['spotsTaken'] as int,
        version: j['version'] as int,
        hostName: (j['host'] as Map<String, dynamic>)['name'] as String,
        hasStarted: j['hasStarted'] as bool? ?? false,
      );

  final String id;
  final String title;
  final String description;
  final String location;
  final DateTime startsAt;
  final int priceCents;
  final String currency;
  final int capacity;
  final int spotsTaken;
  final int version;
  final String hostName;
  final bool hasStarted;

  int get spotsLeft => capacity - spotsTaken;

  /// Live updates only apply if they're newer, so stale or duplicate messages can't win.
  Activity withAvailability(AvailabilityUpdate u) {
    if (u.activityId != id || u.version <= version) return this;
    return Activity(
      id: id,
      title: title,
      description: description,
      location: location,
      startsAt: startsAt,
      priceCents: priceCents,
      currency: currency,
      capacity: u.capacity,
      spotsTaken: u.spotsTaken,
      version: u.version,
      hostName: hostName,
      hasStarted: hasStarted,
    );
  }

  String get price {
    if (priceCents == 0) return 'Free';
    final amount = priceCents % 100 == 0 ? (priceCents ~/ 100).toString() : (priceCents / 100).toStringAsFixed(2);
    return currency == 'USD' ? '\$$amount' : '$amount $currency';
  }
}

class AvailabilityUpdate {
  AvailabilityUpdate({
    required this.activityId,
    required this.spotsTaken,
    required this.capacity,
    required this.version,
    required this.committedAt,
  });

  factory AvailabilityUpdate.fromJson(Map<String, dynamic> j) => AvailabilityUpdate(
        activityId: j['activityId'] as String,
        spotsTaken: j['spotsTaken'] as int,
        capacity: j['capacity'] as int,
        version: j['version'] as int,
        committedAt: j['committedAt'] as int,
      );

  final String activityId;
  final int spotsTaken;
  final int capacity;
  final int version;
  final int committedAt;
}

enum InviteStatus { valid, expired, used, full }

class ResolvedInvite {
  ResolvedInvite({
    required this.code,
    required this.rail,
    required this.status,
    required this.contactLabel,
    required this.inviterName,
    required this.activity,
    required this.going,
    required this.isInviter,
  });

  factory ResolvedInvite.fromJson(Map<String, dynamic> j) {
    final invite = j['invite'] as Map<String, dynamic>;
    return ResolvedInvite(
      code: invite['code'] as String,
      rail: invite['rail'] as String,
      status: InviteStatus.values.byName(invite['status'] as String),
      contactLabel: invite['contactLabel'] as String?,
      inviterName: (invite['inviter'] as Map<String, dynamic>)['name'] as String,
      activity: Activity.fromJson(j['activity'] as Map<String, dynamic>),
      going: j['myBooking'] != null,
      isInviter: j['isInviter'] as bool? ?? false,
    );
  }

  final String code;
  final String rail;
  final InviteStatus status;
  final String? contactLabel;
  final String inviterName;
  final Activity activity;
  final bool going;
  final bool isInviter;

  bool get isVouch => rail == 'vouch';

  ResolvedInvite copyWith({Activity? activity, bool? going}) => ResolvedInvite(
        code: code,
        rail: rail,
        status: status,
        contactLabel: contactLabel,
        inviterName: inviterName,
        activity: activity ?? this.activity,
        going: going ?? this.going,
        isInviter: isInviter,
      );

  /// What the guest should see right now, taking live availability into account.
  InviteStatus get effectiveStatus {
    if (status == InviteStatus.valid && activity.spotsLeft <= 0) return InviteStatus.full;
    if (status == InviteStatus.full && activity.spotsLeft > 0) return InviteStatus.valid;
    return status;
  }
}

class Attendee {
  Attendee(this.name, this.via);
  final String name;
  final String via;
}

class ClaimResult {
  ClaimResult({required this.userId, required this.userName, required this.activity});
  final String userId;
  final String userName;
  final Activity activity;
}

class Api {
  Api(this.store, {http.Client? client}) : _client = client ?? http.Client();

  final Store store;
  final http.Client _client;
  static const _timeout = Duration(seconds: 10);

  Map<String, String> get _headers => {
        'content-type': 'application/json',
        'x-device-id': store.deviceId,
        if (store.userId != null) 'x-user-id': store.userId!,
      };

  Future<Map<String, dynamic>> _send(String method, String path, [Object? body]) async {
    final uri = Uri.parse('$apiUrl$path');
    http.Response res;
    try {
      final req = http.Request(method, uri)..headers.addAll(_headers);
      if (body != null) req.body = jsonEncode(body);
      res = await http.Response.fromStream(await _client.send(req).timeout(_timeout));
    } on Exception {
      throw ApiException(0, 'OFFLINE', "You're offline. We'll keep trying.");
    }
    // A proxy or load balancer can answer with an HTML error page; treat that as a failed request.
    Map<String, dynamic> json;
    try {
      final decoded = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body);
      json = decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
    } on FormatException {
      json = <String, dynamic>{};
      if (res.statusCode < 400) throw ApiException(502, 'BAD_RESPONSE', 'Something went wrong on our side. Retrying…');
    }
    if (res.statusCode >= 400) {
      final err = json['error'] as Map<String, dynamic>? ?? {};
      throw ApiException(
        res.statusCode,
        err['code'] as String? ?? 'UNKNOWN',
        err['message'] as String? ?? 'Something went wrong. Please try again.',
      );
    }
    return json;
  }

  /// Opening an invite. Successful results are cached so the guest can see them offline.
  Future<ResolvedInvite> resolveInvite(String code) async {
    final json = await _send('GET', '/invites/$code');
    await store.cacheInvite(code, json);
    return ResolvedInvite.fromJson(json);
  }

  ResolvedInvite? cachedInvite(String code) {
    final json = store.cachedInvite(code);
    return json == null ? null : ResolvedInvite.fromJson(json);
  }

  Future<ClaimResult> claim(String code, {required String idempotencyKey, String? name}) async {
    final json = await _send('POST', '/invites/$code/claim', {
      'idempotencyKey': idempotencyKey,
      if (store.userId == null && name != null) 'name': name,
    });
    final user = json['user'] as Map<String, dynamic>;
    return ClaimResult(
      userId: user['id'] as String,
      userName: user['name'] as String,
      activity: Activity.fromJson(json['activity'] as Map<String, dynamic>),
    );
  }

  Future<List<Attendee>> attendees(String activityId) async {
    final json = await _send('GET', '/activities/$activityId/attendees');
    return (json['attendees'] as List)
        .cast<Map<String, dynamic>>()
        .map((a) => Attendee(a['name'] as String, a['via'] as String))
        .toList();
  }

  /// Fire-and-forget telemetry.
  Future<void> reportLatency(String activityId, int latencyMs, int version) async {
    try {
      await _send('POST', '/events', {
        'events': [
          {'name': 'availability_received', 'activityId': activityId, 'latencyMs': latencyMs, 'version': version},
        ],
      });
    } catch (_) {}
  }
}
