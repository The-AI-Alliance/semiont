/**
 * Harness-only. Forwards the e2e container's localhost ports to the host
 * bridge so BOTH Node (globalSetup's seed) and Chromium can use
 * `http://localhost:*`. Chromium then gets a real secure context — which
 * PKCE in the browser requires — and the KB the tests register is the
 * same origin the launcher advertises, so the app sees one KB, not two.
 *
 * Each port goes to where a container dials it under Apple container. The
 * Browser and the gateway listen for a person on the Mac's loopback, which
 * no container reaches, so they are forwarded to their containers' side on
 * the bridge address, 10000 above. The gateway's port is the knowledge
 * base's own (a second one here has the next port block), so it is the port
 * E2E_GATEWAY_URL names. The launcher's suite holds this map to the
 * launcher's own (`packages/go/launcher/exposure_test.go`).
 *
 * A stopgap: the container cannot reach the host as localhost.
 */
import net from 'node:net';
const HOST = process.env.E2E_HOST_BRIDGE ?? '192.168.64.1';
if (!process.env.E2E_GATEWAY_URL) {
  throw new Error('E2E_GATEWAY_URL names the gateway the bridge forwards: set it as for the suite');
}
const gateway = Number(new URL(process.env.E2E_GATEWAY_URL).port);
if (!gateway) throw new Error(`E2E_GATEWAY_URL (${process.env.E2E_GATEWAY_URL}) names no port`);
const PORTS = { 3000: 13000, 8080: 8080, 24100: 24100, [gateway]: gateway + 10000 };
for (const [local, remote] of Object.entries(PORTS)) {
  net.createServer((c) => {
    const up = net.connect(remote, HOST);
    c.on('error', () => up.destroy());
    up.on('error', () => c.destroy());
    c.pipe(up).pipe(c);
  }).listen(Number(local), '127.0.0.1', () => console.log(`[bridge] 127.0.0.1:${local} -> ${HOST}:${remote}`));
}
