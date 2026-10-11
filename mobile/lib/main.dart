import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';

import 'api.dart';
import 'screens/enter_code_screen.dart';
import 'screens/invite_screen.dart';
import 'store.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = await Store.open();
  runApp(VelioGuestApp(api: Api(store)));
}

class VelioGuestApp extends StatefulWidget {
  const VelioGuestApp({super.key, required this.api, this.listenForLinks = true});
  final Api api;
  final bool listenForLinks;

  @override
  State<VelioGuestApp> createState() => _VelioGuestAppState();
}

class _VelioGuestAppState extends State<VelioGuestApp> {
  final _navigator = GlobalKey<NavigatorState>();
  StreamSubscription<Uri>? _links;
  String? _openCode;

  @override
  void initState() {
    super.initState();
    // velio://invite/CODE and https://…/i/CODE both land on the invite.
    if (widget.listenForLinks) {
      _links = AppLinks().uriLinkStream.listen((uri) => openInvite(uri.toString()));
    }
    // A claim made offline is still waiting: take the guest straight back to it.
    final pending = widget.api.store.pendingClaim;
    if (pending != null) WidgetsBinding.instance.addPostFrameCallback((_) => openInvite(pending.code));
  }

  void openInvite(String raw) {
    final code = normalizeCode(raw);
    if (code.length < 4 || code == _openCode) return;
    _openCode = code;
    widget.api.store.setLastCode(code);
    _navigator.currentState
        ?.push(MaterialPageRoute(builder: (_) => InviteScreen(api: widget.api, code: code)))
        .then((_) => _openCode = null);
  }

  @override
  void dispose() {
    _links?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Velio',
      navigatorKey: _navigator,
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: EnterCodeScreen(store: widget.api.store, onSubmit: openInvite),
    );
  }
}
