// issuer.mjs <port> <audience> <token file> — the knowledge base's issuer,
// stood in for as the gateway reaches one: OIDC discovery and the key set it
// names, on 127.0.0.1:<port>. Once it listens it writes <token file>: one
// access token it signed RS256 for an agent's account, for <audience>. It
// serves until killed.
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const [port, audience, tokenFile] = process.argv.slice(2);
const issuer = `http://127.0.0.1:${port}`;

// The claim and the role names, read out of the bearer scheme's own text as the
// conformance suite reads them: each appears there, and a rename there fails here.
const scheme = JSON.parse(readFileSync(new URL('../../../specs/src/openapi.json', import.meta.url), 'utf8'))
  .components.securitySchemes.bearerAuth.description;
const declared = (name) => {
  if (!scheme.includes(`\`${name}\``)) throw new Error(`the bearerAuth scheme no longer declares \`${name}\``);
  return name;
};

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'bench';
const documents = {
  '/.well-known/openid-configuration': { issuer, jwks_uri: `${issuer}/keys` },
  '/keys': { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] },
};

// An agent's account, as the realm grants one: the kind it stamps on every
// agent's, and semiont-worker, whose coefficients are unlimited
// (x-semiont-limits), so the benchmark measures the gateway rather than a
// principal's bucket. No `name`: the gateway publishes no profile for it.
const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: issuer,
  aud: audience,
  sub: 'service-account-load',
  azp: 'load',
  [declared('kind')]: declared('agent'),
  [declared('roles')]: [declared('semiont-worker')],
  iat: now,
  exp: now + 36000,
};
const encoded = (part) => Buffer.from(JSON.stringify(part)).toString('base64url');
const signed = `${encoded({ alg: 'RS256', typ: 'JWT', kid })}.${encoded(claims)}`;
const token = `${signed}.${sign('sha256', Buffer.from(signed), privateKey).toString('base64url')}`;

createServer((req, res) => {
  const document = req.method === 'GET' ? documents[req.url] : undefined;
  res.writeHead(document === undefined ? 404 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(document ?? {}));
}).listen(Number(port), '127.0.0.1', () => {
  // Whole or not at all: the bench reads the file as soon as it is there.
  writeFileSync(`${tokenFile}.part`, token);
  renameSync(`${tokenFile}.part`, tokenFile);
});
