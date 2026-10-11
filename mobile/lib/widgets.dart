import 'package:flutter/material.dart';

import 'api.dart';
import 'live.dart';
import 'theme.dart';

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

String formatWhen(DateTime d) {
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  final m = d.minute.toString().padLeft(2, '0');
  return '${_days[d.weekday - 1]} ${d.day} ${_months[d.month - 1]} · $h:$m ${d.hour < 12 ? 'AM' : 'PM'}';
}

/// Pulsing placeholder while content loads.
class Skeleton extends StatefulWidget {
  const Skeleton({super.key, this.height = 20, this.width = double.infinity, this.radius = 10});
  final double height;
  final double width;
  final double radius;

  @override
  State<Skeleton> createState() => _SkeletonState();
}

class _SkeletonState extends State<Skeleton> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final base = Theme.of(context).colorScheme.onSurface;
    return FadeTransition(
      opacity: Tween(begin: 0.05, end: 0.12).animate(_c),
      child: Container(
        height: widget.height,
        width: widget.width,
        decoration: BoxDecoration(color: base, borderRadius: BorderRadius.circular(widget.radius)),
      ),
    );
  }
}

class InfoBanner extends StatelessWidget {
  const InfoBanner({super.key, required this.color, required this.icon, required this.child});
  final Color color;
  final String icon;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(14)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(icon, style: const TextStyle(fontSize: 22)),
          const SizedBox(width: 12),
          Expanded(child: DefaultTextStyle.merge(style: const TextStyle(fontSize: 15, height: 1.35), child: child)),
        ],
      ),
    );
  }
}

class LiveIndicator extends StatelessWidget {
  const LiveIndicator({super.key, required this.state});
  final LiveState state;

  @override
  Widget build(BuildContext context) {
    final (color, label) = switch (state) {
      LiveState.live => (VelioColors.ok, 'Live'),
      LiveState.connecting => (Colors.grey, 'Connecting'),
      LiveState.offline => (VelioColors.warn, 'Reconnecting'),
    };
    return Row(mainAxisSize: MainAxisSize.min, children: [
      AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        width: 8,
        height: 8,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      ),
      const SizedBox(width: 6),
      Text(label, style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant)),
    ]);
  }
}

/// Spots bar + count. The count animates when a live update changes it.
class Availability extends StatelessWidget {
  const Availability({super.key, required this.activity});
  final Activity activity;

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
    final left = activity.spotsLeft;
    final full = left <= 0;
    final fraction = activity.capacity == 0 ? 0.0 : activity.spotsTaken / activity.capacity;
    final color = full ? muted : (left <= 3 ? VelioColors.brand : VelioColors.ok);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ClipRRect(
        borderRadius: BorderRadius.circular(99),
        child: TweenAnimationBuilder<double>(
          tween: Tween(end: fraction),
          duration: const Duration(milliseconds: 400),
          builder: (_, v, __) => LinearProgressIndicator(
            value: v,
            minHeight: 8,
            color: full ? muted : VelioColors.brand,
            backgroundColor: muted.withValues(alpha: 0.15),
          ),
        ),
      ),
      const SizedBox(height: 8),
      Row(children: [
        Text('${activity.spotsTaken} / ${activity.capacity} going', style: TextStyle(color: muted, fontSize: 13)),
        const Spacer(),
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 250),
          transitionBuilder: (child, anim) => ScaleTransition(scale: anim, child: child),
          child: Text(
            full ? 'Sold out' : '$left ${left == 1 ? 'spot' : 'spots'} left',
            key: ValueKey(left),
            style: TextStyle(color: color, fontWeight: FontWeight.w700, fontSize: 13),
          ),
        ),
      ]),
    ]);
  }
}

class ActivityDetails extends StatelessWidget {
  const ActivityDetails({super.key, required this.activity});
  final Activity activity;

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
    Widget line(IconData icon, String text) => Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Row(children: [
            Icon(icon, size: 16, color: muted),
            const SizedBox(width: 8),
            Expanded(child: Text(text, style: TextStyle(color: muted))),
          ]),
        );
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(activity.title, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: -0.5)),
      const SizedBox(height: 4),
      line(Icons.event, formatWhen(activity.startsAt)),
      if (activity.location.isNotEmpty) line(Icons.place_outlined, activity.location),
      line(Icons.sell_outlined, '${activity.price} · not charged in this prototype'),
      line(Icons.person_outline, 'Hosted by ${activity.hostName}'),
      if (activity.description.isNotEmpty) ...[
        const SizedBox(height: 12),
        Text(activity.description, style: const TextStyle(fontSize: 15, height: 1.4)),
      ],
    ]);
  }
}
