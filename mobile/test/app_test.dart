import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:velio_guest/api.dart';
import 'package:velio_guest/screens/enter_code_screen.dart';
import 'package:velio_guest/screens/invite_screen.dart';
import 'package:velio_guest/store.dart';

Map<String, dynamic> activityJson({int taken = 3, int capacity = 8, int version = 3}) => {
      'id': 'a1',
      'title': 'Sunset Kayaking',
      'description': 'Paddle out at golden hour.',
      'location': 'Lekki Lagoon',
      'startsAt': DateTime.now().add(const Duration(days: 2)).toUtc().toIso8601String(),
      'priceCents': 4500,
      'currency': 'USD',
      'capacity': capacity,
      'spotsTaken': taken,
      'spotsLeft': capacity - taken,
      'version': version,
      'host': {'id': 'h1', 'name': 'Tobi'},
      'hasStarted': false,
    };

Map<String, dynamic> inviteJson({String status = 'valid', int taken = 3, int capacity = 8}) => {
      'invite': {
        'code': 'ABCD2345',
        'rail': 'vouch',
        'status': status,
        'contactLabel': 'Ben',
        'inviter': {'id': 'u1', 'name': 'Ada'},
        'expiresAt': DateTime.now().add(const Duration(days: 1)).toUtc().toIso8601String(),
      },
      'activity': activityJson(taken: taken, capacity: capacity),
      'myBooking': null,
      'isInviter': false,
    };

void main() {
  group('normalizeCode', () {
    test('accepts codes, deep links and web links', () {
      expect(normalizeCode(' abcd-2345 '), 'ABCD2345');
      expect(normalizeCode('velio://invite/abcd2345'), 'ABCD2345');
      expect(normalizeCode('http://localhost:3000/i/ABCD2345'), 'ABCD2345');
    });
  });

  group('live availability', () {
    final activity = Activity.fromJson(activityJson());

    test('applies newer versions', () {
      final next = activity.withAvailability(
          AvailabilityUpdate(activityId: 'a1', spotsTaken: 4, capacity: 8, version: 4, committedAt: 0));
      expect(next.spotsLeft, 4);
    });

    test('ignores stale or duplicate versions', () {
      final stale = activity.withAvailability(
          AvailabilityUpdate(activityId: 'a1', spotsTaken: 1, capacity: 8, version: 2, committedAt: 0));
      expect(stale.spotsLeft, 5);
    });

    test('a valid invite shows as full when the last spot goes live', () {
      final invite = ResolvedInvite.fromJson(inviteJson());
      final full = invite.copyWith(
          activity: invite.activity.withAvailability(
              AvailabilityUpdate(activityId: 'a1', spotsTaken: 8, capacity: 8, version: 9, committedAt: 0)));
      expect(full.effectiveStatus, InviteStatus.full);
    });
  });

  group('screens', () {
    late Store store;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      store = await Store.open();
    });

    testWidgets('enter code: button enables once a code is typed', (tester) async {
      String? opened;
      await tester.pumpWidget(MaterialApp(home: EnterCodeScreen(store: store, onSubmit: (c) => opened = c)));
      final button = find.widgetWithText(FilledButton, 'Open invite');
      expect(tester.widget<FilledButton>(button).onPressed, isNull);
      await tester.enterText(find.byKey(const Key('codeField')), 'abcd2345');
      await tester.pump();
      await tester.tap(button);
      expect(opened, 'abcd2345');
    });

    testWidgets('claims a spot with a first name and shows success', (tester) async {
      String? claimedName;
      final client = MockClient((req) async {
        if (req.method == 'GET' && req.url.path == '/invites/ABCD2345') {
          return http.Response(jsonEncode(inviteJson()), 200);
        }
        if (req.method == 'POST' && req.url.path == '/invites/ABCD2345/claim') {
          claimedName = (jsonDecode(req.body) as Map)['name'] as String?;
          return http.Response(
              jsonEncode({
                'user': {'id': 'g1', 'name': 'Ben', 'generation': 1},
                'booking': {'id': 'b1'},
                'activity': activityJson(taken: 4, version: 4),
              }),
              201);
        }
        if (req.url.path.endsWith('/attendees')) {
          return http.Response(
              jsonEncode({
                'attendees': [
                  {'name': 'Ada', 'via': 'direct'},
                  {'name': 'Ben', 'via': 'vouch'},
                ]
              }),
              200);
        }
        return http.Response('{}', 404);
      });
      final api = Api(store, client: client);

      await tester.pumpWidget(MaterialApp(home: InviteScreen(api: api, code: 'ABCD2345', live: false)));
      await tester.pumpAndSettle();
      expect(find.textContaining('vouched for Ben'), findsOneWidget);
      expect(find.text('5 spots left'), findsOneWidget);

      await tester.enterText(find.byKey(const Key('nameField')), 'Ben');
      await tester.pump();
      await tester.tap(find.byKey(const Key('claimButton')));
      await tester.pumpAndSettle();

      expect(claimedName, 'Ben');
      expect(find.text('You\'re in, Ben!'), findsOneWidget);
      expect(store.userId, 'g1');
      expect(store.pendingClaim, isNull);
    });

    testWidgets('offline: shows cached details and queues the claim with one idempotency key', (tester) async {
      await store.cacheInvite('ABCD2345', inviteJson());
      await store.setUser('g1', 'Ben');
      final keys = <String>[];
      final client = MockClient((req) async {
        if (req.method == 'POST') keys.add((jsonDecode(req.body) as Map)['idempotencyKey'] as String);
        throw const SocketExceptionLike();
      });
      final api = Api(store, client: client);

      await tester.pumpWidget(MaterialApp(home: InviteScreen(api: api, code: 'ABCD2345', live: false)));
      await tester.pump();
      expect(find.textContaining('Offline'), findsOneWidget);
      expect(find.text('Sunset Kayaking'), findsOneWidget);

      await tester.tap(find.byKey(const Key('claimButton')));
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('Waiting for a connection'), findsOneWidget);
      expect(store.pendingClaim, isNotNull);

      // Retries reuse the saved key, so a request that did get through can't book twice.
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      expect(keys.length, greaterThanOrEqualTo(2));
      expect(keys.toSet().length, 1);

      await tester.tap(find.text('Cancel'));
      await tester.pump();
      expect(store.pendingClaim, isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a full activity explains itself instead of offering a dead button', (tester) async {
      final client = MockClient((req) async => http.Response(jsonEncode(inviteJson(status: 'full', taken: 8)), 200));
      await tester.pumpWidget(MaterialApp(home: InviteScreen(api: Api(store, client: client), code: 'ABCD2345', live: false)));
      await tester.pumpAndSettle();
      expect(find.textContaining('just filled up'), findsOneWidget);
      expect(find.byKey(const Key('claimButton')), findsNothing);
    });
  });
}

class SocketExceptionLike implements Exception {
  const SocketExceptionLike();
}
