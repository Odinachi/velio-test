import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:velio_guest/api.dart';
import 'package:velio_guest/screens/invite_screen.dart';
import 'package:velio_guest/store.dart';

import 'app_test.dart' show activityJson, inviteJson;

Map<String, dynamic> invite({
  String status = 'valid',
  int taken = 3,
  int capacity = 8,
  bool going = false,
  bool isInviter = false,
}) =>
    {
      ...inviteJson(status: status, taken: taken, capacity: capacity),
      'myBooking': going ? {'id': 'b0'} : null,
      'isInviter': isInviter,
    };

http.Response json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status);

http.Response apiError(int status, String code, String message) =>
    json({'error': {'code': code, 'message': message}}, status);

final claimOk = json({
  'user': {'id': 'g1', 'name': 'Ben', 'generation': 1},
  'booking': {'id': 'b1'},
  'activity': activityJson(taken: 4, version: 4),
}, 201);

/// Routes requests to handlers and records what the screen sent.
class FakeServer {
  FakeServer({required this.onGet, this.onClaim});
  http.Response Function() onGet;
  http.Response Function(Map<String, dynamic> body)? onClaim;
  final claims = <Map<String, dynamic>>[];
  int gets = 0;

  late final client = MockClient((req) async {
    if (req.url.path.endsWith('/claim')) {
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      claims.add(body);
      return onClaim!(body);
    }
    if (req.url.path.endsWith('/attendees')) return json({'attendees': <Object>[]});
    if (req.url.path.startsWith('/invites/')) {
      gets++;
      return onGet();
    }
    return json({}, 404);
  });
}

void main() {
  late Store store;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    store = await Store.open();
  });

  Future<void> open(WidgetTester tester, FakeServer server) async {
    await tester.pumpWidget(MaterialApp(home: InviteScreen(api: Api(store, client: server.client), code: 'ABCD2345', live: false)));
    await tester.pumpAndSettle();
  }

  Future<void> claimAs(WidgetTester tester, String name) async {
    await tester.enterText(find.byKey(const Key('nameField')), name);
    await tester.pump();
    await tester.tap(find.byKey(const Key('claimButton')));
    await tester.pump();
    await tester.pump();
  }

  FilledButton claimButton(WidgetTester tester) => tester.widget<FilledButton>(find.byKey(const Key('claimButton')));

  group('parsing junk', () {
    test('normalizeCode survives empty, emoji-only, very long and tracking-parameter input', () {
      expect(normalizeCode(''), '');
      expect(normalizeCode('🛶🛶🛶'), '');
      expect(normalizeCode('https://velio.app/i/abcd2345?ref=whatsapp&utm=x'), 'ABCD2345');
      expect(normalizeCode('a' * 5000).length, 5000);
    });

    test('prices: free, cents, and non-USD currencies', () {
      Activity priced(int cents, String currency) => Activity.fromJson({...activityJson(), 'priceCents': cents, 'currency': currency});
      expect(priced(0, 'USD').price, 'Free');
      expect(priced(4550, 'USD').price, '\$45.50');
      expect(priced(5000, 'EUR').price, '50 EUR');
    });

    test("ignores live updates meant for a different activity", () {
      final a = Activity.fromJson(activityJson());
      final other = a.withAvailability(AvailabilityUpdate(activityId: 'zz', spotsTaken: 8, capacity: 8, version: 99, committedAt: 0));
      expect(other.spotsLeft, a.spotsLeft);
    });

    test('a full invite becomes claimable again when a spot frees up, but a used one never does', () {
      final full = ResolvedInvite.fromJson(invite(status: 'full', taken: 8));
      expect(full.effectiveStatus, InviteStatus.full);
      final freed = full.copyWith(
          activity: full.activity.withAvailability(
              AvailabilityUpdate(activityId: 'a1', spotsTaken: 7, capacity: 8, version: 10, committedAt: 0)));
      expect(freed.effectiveStatus, InviteStatus.valid);

      final used = ResolvedInvite.fromJson(invite(status: 'used'));
      expect(used.effectiveStatus, InviteStatus.used);
    });
  });

  group('invite states', () {
    testWidgets('expired invite: explains it and offers no claim button', (tester) async {
      await open(tester, FakeServer(onGet: () => json(invite(status: 'expired'))));
      expect(find.text('This invite has expired.'), findsOneWidget);
      expect(find.byKey(const Key('claimButton')), findsNothing);
    });

    testWidgets('used vouch: tells the guest who to ask for a new one', (tester) async {
      await open(tester, FakeServer(onGet: () => json(invite(status: 'used'))));
      expect(find.textContaining('Ask Ada to send you a new one'), findsOneWidget);
      expect(find.byKey(const Key('claimButton')), findsNothing);
    });

    testWidgets('unknown code: a clear message and a way back, not a spinner forever', (tester) async {
      await open(tester, FakeServer(onGet: () => apiError(404, 'INVITE_NOT_FOUND', "We couldn't find that invite.")));
      expect(find.text("We couldn't find that invite"), findsOneWidget);
      expect(find.text('Check the code'), findsOneWidget);
    });

    testWidgets('the inviter opening their own link sees a nudge, not a claim button', (tester) async {
      await open(tester, FakeServer(onGet: () => json(invite(isInviter: true))));
      expect(find.textContaining('This is your own invite'), findsOneWidget);
      expect(find.byKey(const Key('claimButton')), findsNothing);
    });

    testWidgets('someone already going lands straight on their plan', (tester) async {
      await open(tester, FakeServer(onGet: () => json(invite(going: true))));
      expect(find.text("You're going!"), findsOneWidget);
    });

    testWidgets('a whitespace-only name keeps the claim button disabled', (tester) async {
      await open(tester, FakeServer(onGet: () => json(invite())));
      await tester.enterText(find.byKey(const Key('nameField')), '    ');
      await tester.pump();
      expect(claimButton(tester).onPressed, isNull);
    });

    testWidgets('a returning guest claims without being asked for their name again', (tester) async {
      await store.setUser('g1', 'Ben');
      final server = FakeServer(onGet: () => json(invite()), onClaim: (_) => claimOk);
      await open(tester, server);
      expect(find.byKey(const Key('nameField')), findsNothing);
      await tester.tap(find.byKey(const Key('claimButton')));
      await tester.pumpAndSettle();
      expect(server.claims.single.containsKey('name'), isFalse);
      expect(find.text("You're in, Ben!"), findsOneWidget);
    });
  });

  group('claim failures', () {
    testWidgets('sold out mid-claim: kind message, no retry loop, and the screen refreshes to "full"', (tester) async {
      var full = false;
      final server = FakeServer(
        onGet: () => json(full ? invite(status: 'full', taken: 8) : invite()),
        onClaim: (_) {
          full = true;
          return apiError(409, 'SOLD_OUT', 'Someone grabbed the last spot a moment before you.');
        },
      );
      await open(tester, server);
      await claimAs(tester, 'Ben');
      await tester.pumpAndSettle();

      expect(find.textContaining('Someone grabbed the last spot'), findsOneWidget);
      expect(find.textContaining('just filled up'), findsOneWidget);
      expect(store.pendingClaim, isNull);
      await tester.pump(const Duration(seconds: 10));
      expect(server.claims, hasLength(1));
    });

    testWidgets('a server error is retried with the same key until it succeeds', (tester) async {
      var attempts = 0;
      final server = FakeServer(
        onGet: () => json(invite()),
        onClaim: (_) => ++attempts < 3 ? apiError(503, 'INTERNAL', 'Try again') : claimOk,
      );
      await open(tester, server);
      await claimAs(tester, 'Ben');
      expect(find.textContaining('Waiting for a connection'), findsOneWidget);

      await tester.pump(const Duration(seconds: 5));
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();

      expect(server.claims, hasLength(3));
      expect(server.claims.map((c) => c['idempotencyKey']).toSet(), hasLength(1));
      expect(find.text("You're in, Ben!"), findsOneWidget);
      expect(store.pendingClaim, isNull);
    });

    testWidgets('a claim interrupted by the app closing resumes on next open with the same key', (tester) async {
      await store.setPendingClaim(PendingClaim(code: 'ABCD2345', idempotencyKey: 'saved-key-123', name: 'Ben'));
      final server = FakeServer(onGet: () => json(invite()), onClaim: (_) => claimOk);
      await open(tester, server);
      expect(server.claims.single['idempotencyKey'], 'saved-key-123');
      expect(server.claims.single['name'], 'Ben');
      expect(find.text("You're in, Ben!"), findsOneWidget);
    });

    testWidgets('a proxy error page (HTML, not JSON) is treated as a retryable failure, not a crash', (tester) async {
      var attempts = 0;
      final server = FakeServer(
        onGet: () => json(invite()),
        onClaim: (_) => ++attempts == 1 ? http.Response('<html><body>502 Bad Gateway</body></html>', 502) : claimOk,
      );
      await open(tester, server);
      await claimAs(tester, 'Ben');
      expect(tester.takeException(), isNull);
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      expect(find.text("You're in, Ben!"), findsOneWidget);
    });

    testWidgets('offline with nothing cached: an honest offline screen that recovers on its own', (tester) async {
      var online = false;
      final server = FakeServer(onGet: () => online ? json(invite()) : throw Exception('no network'));
      await open(tester, server);
      expect(find.text("You're offline"), findsOneWidget);

      online = true;
      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();
      expect(find.text('Sunset Kayaking'), findsOneWidget);
      expect(find.byKey(const Key('claimButton')), findsOneWidget);
    });
  });
}
