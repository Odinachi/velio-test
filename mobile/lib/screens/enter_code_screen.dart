import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../store.dart';
import '../theme.dart';

class EnterCodeScreen extends StatefulWidget {
  const EnterCodeScreen({super.key, required this.store, required this.onSubmit});
  final Store store;
  final void Function(String code) onSubmit;

  @override
  State<EnterCodeScreen> createState() => _EnterCodeScreenState();
}

class _EnterCodeScreenState extends State<EnterCodeScreen> {
  final _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    _controller.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _valid => normalizeCode(_controller.text).length >= 6;

  void _submit() {
    if (!_valid) return;
    HapticFeedback.selectionClick();
    FocusScope.of(context).unfocus();
    widget.onSubmit(_controller.text);
  }

  Future<void> _paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text == null || text.isEmpty) return;
    HapticFeedback.selectionClick();
    _controller.text = normalizeCode(text);
    if (_valid) _submit();
  }

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
    final last = widget.store.lastCode;
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
          children: [
            const Text.rich(
              TextSpan(children: [
                TextSpan(text: 'velio'),
                TextSpan(text: '.', style: TextStyle(color: VelioColors.brand)),
              ]),
              style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800, letterSpacing: -1),
            ),
            const SizedBox(height: 48),
            const Text('Got an invite?', style: TextStyle(fontSize: 32, fontWeight: FontWeight.w800, letterSpacing: -0.8)),
            const SizedBox(height: 8),
            Text('Open the link a friend sent you, or type the code here.', style: TextStyle(fontSize: 16, color: muted)),
            const SizedBox(height: 32),
            TextField(
              key: const Key('codeField'),
              controller: _controller,
              autofocus: last == null,
              textCapitalization: TextCapitalization.characters,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: TextInputAction.go,
              onSubmitted: (_) => _submit(),
              inputFormatters: [LengthLimitingTextInputFormatter(64)],
              style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700, letterSpacing: 4, fontFamily: 'monospace'),
              textAlign: TextAlign.center,
              decoration: InputDecoration(
                hintText: 'ABCD2345',
                hintStyle: TextStyle(color: muted.withValues(alpha: 0.4), letterSpacing: 4),
                suffixIcon: IconButton(tooltip: 'Paste', icon: const Icon(Icons.content_paste), onPressed: _paste),
              ),
            ),
            const SizedBox(height: 16),
            FilledButton(onPressed: _valid ? _submit : null, child: const Text('Open invite')),
            if (last != null) ...[
              const SizedBox(height: 12),
              TextButton(
                onPressed: () => widget.onSubmit(last),
                child: Text('Continue with $last'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
