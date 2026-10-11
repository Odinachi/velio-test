import 'dart:convert';
import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

/// Everything the guest app keeps on the phone: identity, cached invites and a pending claim.
class Store {
  Store._(this._prefs);

  static Future<Store> open() async => Store._(await SharedPreferences.getInstance());

  final SharedPreferences _prefs;

  String get deviceId {
    var id = _prefs.getString('deviceId');
    if (id == null) {
      id = 'app-${newKey()}';
      _prefs.setString('deviceId', id);
    }
    return id;
  }

  String? get userId => _prefs.getString('userId');
  String? get userName => _prefs.getString('userName');

  Future<void> setUser(String id, String name) async {
    await _prefs.setString('userId', id);
    await _prefs.setString('userName', name);
  }

  String? get lastCode => _prefs.getString('lastCode');
  Future<void> setLastCode(String code) => _prefs.setString('lastCode', code);

  Future<void> cacheInvite(String code, Map<String, dynamic> json) =>
      _prefs.setString('invite:$code', jsonEncode({...json, '_cachedAt': DateTime.now().toIso8601String()}));

  Map<String, dynamic>? cachedInvite(String code) {
    final raw = _prefs.getString('invite:$code');
    return raw == null ? null : jsonDecode(raw) as Map<String, dynamic>;
  }

  DateTime? cachedAt(String code) {
    final at = cachedInvite(code)?['_cachedAt'] as String?;
    return at == null ? null : DateTime.parse(at);
  }

  /// A claim the guest made while offline. Kept with its idempotency key so retrying can never
  /// take two spots.
  PendingClaim? get pendingClaim {
    final raw = _prefs.getString('pendingClaim');
    return raw == null ? null : PendingClaim.fromJson(jsonDecode(raw) as Map<String, dynamic>);
  }

  Future<void> setPendingClaim(PendingClaim? claim) => claim == null
      ? _prefs.remove('pendingClaim')
      : _prefs.setString('pendingClaim', jsonEncode(claim.toJson()));
}

class PendingClaim {
  PendingClaim({required this.code, required this.idempotencyKey, this.name});

  factory PendingClaim.fromJson(Map<String, dynamic> j) =>
      PendingClaim(code: j['code'] as String, idempotencyKey: j['key'] as String, name: j['name'] as String?);

  final String code;
  final String idempotencyKey;
  final String? name;

  Map<String, dynamic> toJson() => {'code': code, 'key': idempotencyKey, 'name': name};
}

final _rng = Random.secure();

/// Random UUID v4 for idempotency keys.
String newKey() {
  final b = List<int>.generate(16, (_) => _rng.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}
