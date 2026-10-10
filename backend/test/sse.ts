/** Minimal SSE client for tests and the load test: connects with fetch and parses frames. */
export interface SseMessage {
  event: string;
  data: any;
  receivedAt: number;
}

export async function openStream(url: string, onMessage: (m: SseMessage) => void) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let resolveHello!: () => void;
  const hello = new Promise<void>((r) => (resolveHello = r));

  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (!data.length) continue;
          const msg = { event, data: JSON.parse(data.join('\n')), receivedAt: Date.now() };
          if (event === 'hello') resolveHello();
          onMessage(msg);
        }
      }
    } catch {
      // aborted
    }
  })();

  await hello;
  return { close: () => controller.abort() };
}
