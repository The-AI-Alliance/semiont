// streams.mjs <origin> <token> <count> — open <count> streams on /bus/subscribe,
// each with its own clientId, read them, and hold them until killed. Prints
// "open <n> failed <m>" once every one has answered.
import { Agent, request } from 'node:http';
import { randomUUID } from 'node:crypto';

const [origin, token, countArg] = process.argv.slice(2);
const count = Number(countArg);
const url = new URL('/bus/subscribe', origin);
const agent = new Agent({ keepAlive: true, maxSockets: Infinity });

let open = 0;
let failed = 0;
const settle = () => {
  if (open + failed === count) console.log(`open ${open} failed ${failed}`);
};

for (let i = 0; i < count; i++) {
  const req = request(
    { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', agent,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
    (res) => {
      if (res.statusCode === 200) open++;
      else failed++;
      res.resume();
      settle();
    },
  );
  req.on('error', () => {
    failed++;
    settle();
  });
  req.end(JSON.stringify({ clientId: randomUUID(), global: ['beckon:focus'] }));
}

setInterval(() => {}, 1 << 30);
