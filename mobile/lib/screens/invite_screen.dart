import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../live.dart';
import '../store.dart';
import '../theme.dart';
import '../widgets.dart';

enum ClaimPhase { idle, claiming, queued, done }

/// The invited guest's whole journey: see who invited you, see the activity live, claim a spot.
class InviteScreen extends StatefulWidget {
  const InviteScreen({super.key, required this.api, required this.code, this.live = true});
  final Api api;
  final String code;
  final bool live;

  @override
  State<InviteScreen> createState() => _InviteScreenState();
}

class _InviteScreenState extends State<InviteScreen> {
  Api get api => widget.api;
  Store get store => api.store;

  ResolvedInvite? _invite;
  bool _fromCache = false;
  ApiException? _error;
  LiveState _live = LiveState.connecting;
  LiveAvailability? _stream;
  ClaimPhase _phase = ClaimPhase.idle;
  String? _claimError;
  List<Attendee> _attendees = [];
  final _name = TextEditingController();
  Timer? _retry;

  @override
  void initState() {
    super.initState();
    _name.text = store.userName ?? '';
    _name.addListener(() => setState(() {}));
    // Show what we saved last time instantly, then refresh from the network.
    final cached = api.cachedInvite(widget.code);
    if (cached != null) {
      _invite = cached;
      _fromCache = true;
    }
    _load();
    final pending = store.pendingClaim;
    if (pending != null && pending.code == widget.code) {
      _phase = ClaimPhase.queued;
      _claim();
    }
  }

  @override
  void dispose() {
    _stream?.close();
    _retry?.cancel();
    _name.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final invite = await api.resolveInvite(widget.code);
      if (!mounted) return;
      setState(() {
        // Keep a newer live count if we already have one.
        final current = _invite?.activity;
        _invite = current != null && current.version > invite.activity.version ? invite.copyWith(activity: current) : invite;
        _fromCache = false;
        _error = null;
      });
      _startLive(invite.activity.id);
      if (invite.going) _loadAttendees();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        if (_invite == null) _error = e;
        if (e.offline) _fromCache = _invite != null;
      });
      // Offline: keep quietly retrying until we're back.
      if (e.offline) {
        _retry?.cancel();
        _retry = Timer(const Duration(seconds: 5), _load);
      }
    }
  }

  void _startLive(String activityId) {
    if (_stream != null || !widget.live) return;
    _stream = LiveAvailability(
      activityId: activityId,
      onState: (s) => mounted ? setState(() => _live = s) : null,
      onUpdate: (u) {
        if (!mounted || _invite == null) return;
        setState(() => _invite = _invite!.copyWith(activity: _invite!.activity.withAvailability(u)));
        if (_phase == ClaimPhase.done) _loadAttendees();
      },
      onReconnect: () {
        _load();
        if (_phase == ClaimPhase.queued) _claim();
      },
      onLatency: (u, ms) => api.reportLatency(u.activityId, ms, u.version),
    )..start();
  }

  Future<void> _loadAttendees() async {
    final invite = _invite;
    if (invite == null) return;
    try {
      final list = await api.attendees(invite.activity.id);
      if (mounted) setState(() => _attendees = list);
    } on ApiException catch (_) {}
  }

  Future<void> _claim() async {
    final needsName = store.userId == null;
    final name = _name.text.trim();
    final existing = store.pendingClaim;
    final pending = existing != null && existing.code == widget.code
        ? existing
        : PendingClaim(code: widget.code, idempotencyKey: newKey(), name: needsName ? name : null);
    if (needsName && (pending.name ?? '').isEmpty) return;

    // Saved before sending: if the app dies mid-request, the same key is retried later and can
    // never take a second spot.
    await store.setPendingClaim(pending);
    if (_phase == ClaimPhase.idle) HapticFeedback.mediumImpact();
    setState(() {
      _phase = _phase == ClaimPhase.queued ? ClaimPhase.queued : ClaimPhase.claiming;
      _claimError = null;
    });

    try {
      final result = await api.claim(widget.code, idempotencyKey: pending.idempotencyKey, name: pending.name);
      await store.setUser(result.userId, result.userName);
      await store.setPendingClaim(null);
      HapticFeedback.heavyImpact();
      if (!mounted) return;
      setState(() {
        _phase = ClaimPhase.done;
        _invite = _invite?.copyWith(going: true, activity: result.activity);
      });
      _loadAttendees();
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.retryable) {
        // Offline or a server hiccup: keep the claim and retry with the same key.
        setState(() => _phase = ClaimPhase.queued);
        _retry?.cancel();
        _retry = Timer(const Duration(seconds: 4), _claim);
        return;
      }
      await store.setPendingClaim(null);
      HapticFeedback.vibrate();
      setState(() {
        _phase = ClaimPhase.idle;
        _claimError = e.code == 'ALREADY_BOOKED' ? null : e.message;
      });
      if (e.code == 'ALREADY_BOOKED') setState(() => _invite = _invite?.copyWith(going: true));
      _load();
    }
  }

  void _cancelQueued() {
    _retry?.cancel();
    store.setPendingClaim(null);
    setState(() => _phase = ClaimPhase.idle);
  }

  @override
  Widget build(BuildContext context) {
    final invite = _invite;
    return Scaffold(
      appBar: AppBar(
        actions: [
          if (invite != null)
            Padding(padding: const EdgeInsets.only(right: 16), child: LiveIndicator(state: _fromCache ? LiveState.offline : _live)),
        ],
      ),
      body: SafeArea(
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 300),
          child: invite == null
              ? (_error != null ? _ErrorView(error: _error!, onRetry: _load) : const _LoadingView())
              : (_phase == ClaimPhase.done || (invite.going && !invite.isInviter))
                  ? _SuccessView(invite: invite, attendees: _attendees, justClaimed: _phase == ClaimPhase.done, name: store.userName)
                  : _InviteView(
                      invite: invite,
                      fromCache: _fromCache,
                      cachedAt: store.cachedAt(widget.code),
                      phase: _phase,
                      claimError: _claimError,
                      nameController: _name,
                      needsName: store.userId == null,
                      onClaim: _claim,
                      onCancelQueued: _cancelQueued,
                    ),
        ),
      ),
    );
  }
}

class _LoadingView extends StatelessWidget {
  const _LoadingView();

  @override
  Widget build(BuildContext context) {
    return ListView(padding: const EdgeInsets.all(24), children: const [
      Skeleton(height: 64, radius: 14),
      SizedBox(height: 24),
      Skeleton(height: 32, width: 240),
      SizedBox(height: 12),
      Skeleton(height: 16, width: 180),
      SizedBox(height: 8),
      Skeleton(height: 16, width: 200),
      SizedBox(height: 24),
      Skeleton(height: 8),
      SizedBox(height: 48),
      Skeleton(height: 56, radius: 14),
    ]);
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.error, required this.onRetry});
  final ApiException error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final (icon, title) = switch (error.code) {
      'INVITE_NOT_FOUND' => ('🔍', 'We couldn\'t find that invite'),
      'OFFLINE' => ('📶', 'You\'re offline'),
      _ => ('😕', 'Something went wrong'),
    };
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
        Text(icon, style: const TextStyle(fontSize: 48)),
        const SizedBox(height: 16),
        Text(title, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800), textAlign: TextAlign.center),
        const SizedBox(height: 8),
        Text(
          error.offline ? 'Connect to the internet to open this invite. We\'ll keep trying.' : error.message,
          textAlign: TextAlign.center,
          style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 24),
        if (error.code == 'INVITE_NOT_FOUND')
          OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Check the code'))
        else
          OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
      ]),
    );
  }
}

class _InviteView extends StatelessWidget {
  const _InviteView({
    required this.invite,
    required this.fromCache,
    required this.cachedAt,
    required this.phase,
    required this.claimError,
    required this.nameController,
    required this.needsName,
    required this.onClaim,
    required this.onCancelQueued,
  });

  final ResolvedInvite invite;
  final bool fromCache;
  final DateTime? cachedAt;
  final ClaimPhase phase;
  final String? claimError;
  final TextEditingController nameController;
  final bool needsName;
  final VoidCallback onClaim;
  final VoidCallback onCancelQueued;

  @override
  Widget build(BuildContext context) {
    final activity = invite.activity;
    final status = invite.effectiveStatus;
    final canClaim = status == InviteStatus.valid && !invite.isInviter && !activity.hasStarted;
    final busy = phase == ClaimPhase.claiming || phase == ClaimPhase.queued;
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;

    return Column(children: [
      Expanded(
        child: ListView(padding: const EdgeInsets.fromLTRB(20, 0, 20, 20), children: [
          if (fromCache) ...[
            InfoBanner(
              color: VelioColors.warn,
              icon: '📶',
              child: Text('Offline. Showing details saved ${cachedAt == null ? 'earlier' : _ago(cachedAt!)}. Spots may have changed.'),
            ),
            const SizedBox(height: 12),
          ],
          InfoBanner(
            color: invite.isVouch ? VelioColors.vouch : VelioColors.brand,
            icon: invite.isVouch ? '🤝' : '👋',
            child: Text.rich(TextSpan(children: [
              TextSpan(text: invite.inviterName, style: const TextStyle(fontWeight: FontWeight.w700)),
              TextSpan(
                text: invite.isVouch
                    ? ' vouched for ${invite.contactLabel ?? 'you'}. This invite is just for you.'
                    : ' invited you along.',
              ),
            ])),
          ),
          const SizedBox(height: 20),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                ActivityDetails(activity: activity),
                const SizedBox(height: 20),
                Availability(activity: activity),
              ]),
            ),
          ),
          const SizedBox(height: 16),
          if (invite.isInviter)
            const InfoBanner(color: VelioColors.brand, icon: '📨', child: Text('This is your own invite. Send it to a friend!'))
          else if (status == InviteStatus.full)
            const InfoBanner(
              color: VelioColors.warn,
              icon: '😕',
              child: Text('This one just filled up. Keep this open: if someone cancels, the spot shows up here live.'),
            )
          else if (status == InviteStatus.used)
            InfoBanner(
              color: VelioColors.warn,
              icon: '🔒',
              child: Text('This invite was already claimed. Ask ${invite.inviterName} to send you a new one.'),
            )
          else if (status == InviteStatus.expired || activity.hasStarted)
            const InfoBanner(color: VelioColors.warn, icon: '⏰', child: Text('This invite has expired.')),
          if (claimError != null) ...[
            const SizedBox(height: 12),
            InfoBanner(color: VelioColors.warn, icon: '⚠️', child: Text(claimError!)),
          ],
        ]),
      ),
      if (canClaim)
        Container(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
          decoration: BoxDecoration(
            color: Theme.of(context).scaffoldBackgroundColor,
            border: Border(top: BorderSide(color: muted.withValues(alpha: 0.15))),
          ),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            if (phase == ClaimPhase.queued) ...[
              Row(children: [
                const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                const SizedBox(width: 10),
                Expanded(child: Text('Waiting for a connection. We\'ll claim your spot as soon as you\'re back.', style: TextStyle(color: muted))),
                TextButton(onPressed: onCancelQueued, child: const Text('Cancel')),
              ]),
              const SizedBox(height: 8),
            ],
            if (needsName && phase == ClaimPhase.idle) ...[
              TextField(
                key: const Key('nameField'),
                controller: nameController,
                textCapitalization: TextCapitalization.words,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => nameController.text.trim().isNotEmpty ? onClaim() : null,
                maxLength: 60,
                decoration: const InputDecoration(hintText: 'Your first name', counterText: ''),
              ),
              const SizedBox(height: 10),
            ],
            FilledButton(
              key: const Key('claimButton'),
              onPressed: busy || (needsName && nameController.text.trim().isEmpty) ? null : onClaim,
              child: busy
                  ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
                  : Text('Claim my spot · ${activity.price}'),
            ),
          ]),
        ),
    ]);
  }

  static String _ago(DateTime t) {
    final d = DateTime.now().difference(t);
    if (d.inMinutes < 1) return 'just now';
    if (d.inHours < 1) return '${d.inMinutes} min ago';
    if (d.inDays < 1) return '${d.inHours} h ago';
    return '${d.inDays} d ago';
  }
}

class _SuccessView extends StatelessWidget {
  const _SuccessView({required this.invite, required this.attendees, required this.justClaimed, required this.name});
  final ResolvedInvite invite;
  final List<Attendee> attendees;
  final bool justClaimed;
  final String? name;

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
    final activity = invite.activity;
    return ListView(padding: const EdgeInsets.fromLTRB(20, 0, 20, 24), children: [
      const SizedBox(height: 8),
      TweenAnimationBuilder<double>(
        tween: Tween(begin: justClaimed ? 0.4 : 1, end: 1),
        duration: const Duration(milliseconds: 500),
        curve: Curves.elasticOut,
        builder: (_, v, child) => Transform.scale(scale: v, child: child),
        child: const Text('🎉', textAlign: TextAlign.center, style: TextStyle(fontSize: 64)),
      ),
      const SizedBox(height: 8),
      Text(
        justClaimed ? 'You\'re in${name != null ? ', $name' : ''}!' : 'You\'re going!',
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800, letterSpacing: -0.5),
      ),
      const SizedBox(height: 6),
      Text(
        '${invite.inviterName} will see you\'re coming.',
        textAlign: TextAlign.center,
        style: TextStyle(color: muted, fontSize: 16),
      ),
      const SizedBox(height: 24),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ActivityDetails(activity: activity),
            const SizedBox(height: 20),
            Availability(activity: activity),
          ]),
        ),
      ),
      const SizedBox(height: 16),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Who\'s going', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            if (attendees.isEmpty) const Skeleton(height: 40),
            for (final a in attendees)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(children: [
                  CircleAvatar(radius: 16, child: Text(a.name.isEmpty ? '?' : a.name[0].toUpperCase())),
                  const SizedBox(width: 12),
                  Expanded(child: Text(a.name)),
                  if (a.via == 'vouch')
                    const Text('vouched', style: TextStyle(color: VelioColors.vouch, fontWeight: FontWeight.w600, fontSize: 12)),
                ]),
              ),
          ]),
        ),
      ),
    ]);
  }
}
