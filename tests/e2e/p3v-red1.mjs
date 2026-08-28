// RED 1 live: a resume with lastEventId receives REPLAY, not bus:resume-gap.
import { SemiontClient, resourceId as rid } from '@semiont/sdk';

const BASE = 'http://192.168.64.1:4000';
const c = await SemiontClient.signInHttp({ baseUrl: BASE, email: 'admin@example.com', password: 'password' });
const auth = await c.auth.password('admin@example.com', 'password');
const token = auth.token;

// A resource with persisted events: newest-first list, pick one with >= 2 events.
const { resources } = await c.browse.resources({ limit: 10 }).fresh();
let target = null, events = null;
for (const r of resources) {
  const ev = await c.browse.events(rid(r['@id'])).fresh();
  if (ev.length >= 2) { target = r['@id']; events = ev; break; }
}
if (!target) { console.log(JSON.stringify({ fail: 'no resource with >=2 events' })); process.exit(1); }
const seqs = events.map(e => e.metadata?.sequenceNumber ?? e.sequenceNumber).sort((a, b) => a - b);
const watermark = `p-${target}-${seqs[0]}`;
const types = [...new Set(events.map(e => e.type))];
console.log(JSON.stringify({ target, seqs, watermark, types }));

// Subscribe with the watermark; collect frames for 6s.
const res = await fetch(`${BASE}/bus/subscribe`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: 'text/event-stream' },
  body: JSON.stringify({ global: [], scoped: [{ scope: target, channels: types, lastEventId: watermark }] }),
});
console.log(JSON.stringify({ subscribeStatus: res.status }));
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const frames = [];
const deadline = Date.now() + 6000;
while (Date.now() < deadline) {
  const { value, done } = await Promise.race([
    reader.read(),
    new Promise(r => setTimeout(() => r({ value: null, done: false }), Math.max(1, deadline - Date.now()))),
  ]);
  if (done) break;
  if (value) buf += dec.decode(value, { stream: true });
}
console.log('RAW>>>', JSON.stringify(buf.slice(0, 1500)));
for (const chunk of buf.split('\n\n')) {
  const id = chunk.match(/^id: (.*)$/m)?.[1];
  const event = chunk.match(/^event: (.*)$/m)?.[1];
  if (event) frames.push({ id, event });
}
const replayed = frames.filter(f => f.id?.startsWith(`p-${target}-`));
const gaps = frames.filter(f => f.event === 'bus:resume-gap');
console.log(JSON.stringify({ frames: frames.length, replayedIds: replayed.map(f => f.id), gaps: gaps.length }));
console.log(JSON.stringify({ verdict: gaps.length === 0 && replayed.length >= seqs.length - 1 ? 'REPLAY-OK' : 'FAIL' }));
c.dispose(); process.exit(0);
