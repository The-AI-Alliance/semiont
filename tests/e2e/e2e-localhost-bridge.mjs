/**
 * Harness-only. Forwards the e2e container's localhost ports to the host
 * bridge so BOTH Node (globalSetup's seed) and Chromium can use
 * `http://localhost:*`. Chromium then gets a real secure context — required
 * since #1394 put PKCE in the browser — and the KB the tests register is the
 * same origin the launcher advertises, so the app sees one KB, not two.
 *
 * Untracked. Delete once the container can reach the host as localhost.
 */
import net from 'node:net';
const HOST = process.env.E2E_HOST_BRIDGE ?? '192.168.64.1';
const PORTS = [3000, 4000, 8080, 24100];
for (const port of PORTS) {
  net.createServer((c) => {
    const up = net.connect(port, HOST);
    c.on('error', () => up.destroy());
    up.on('error', () => c.destroy());
    c.pipe(up).pipe(c);
  }).listen(port, '127.0.0.1', () => console.log(`[bridge] 127.0.0.1:${port} -> ${HOST}:${port}`));
}
