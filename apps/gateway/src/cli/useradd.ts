/**
 * Create or update an account at this knowledge base's identity provider.
 * Invoked inside the gateway container by `semiont useradd`, which execs it and
 * passes every flag through verbatim.
 *
 * (No shebang — tsup's `banner` adds one to every entry.)
 *
 * A user is ONE thing now: the account at the issuer, which owns the credential,
 * mints the `sub` its tokens carry, and decides whether the person may sign in
 * (`--active` / `--inactive` set that there). Semiont keeps no row of its own —
 * everything the gateway knows about a caller it reads off the token, and the
 * identity is a DID derived from those claims rather than a local id.
 *
 * So this command no longer touches a database, and there is no display name or
 * role to pre-create: the issuer holds the profile, and nothing here grants
 * access on the basis of a role.
 */

import * as crypto from 'crypto';
import { loadEnvironmentConfig } from '@semiont/core/node';
import { KeycloakAdminApi } from '../identity/keycloak-admin';

interface Options {
  email: string;
  passwordStdin: boolean;
  generatePassword: boolean;
  active: boolean;
  inactive: boolean;
  update: boolean;
  upsert: boolean;
}

const USAGE = `Usage: semiont-useradd --email <email> [--password-stdin | --generate-password] [options]

Creates the account at this knowledge base's identity provider. Creating a user
requires a password, so one of --password-stdin or --generate-password. Updating
an existing one does not: pass --password-stdin only when the point is to CHANGE
the password.

Semiont stores nothing of its own about a user — the issuer holds the account and
the profile, and the gateway reads what it needs off the token. There are no role
flags, because no route here grants access on the basis of a role, and no display
name: the realm asks the person for their own at first sign-in.

  --email <email>       User email address (required)
  --password-stdin      Read the password from stdin, first line (min 8 chars)
  --generate-password   Generate a random password (printed once)
  --inactive            Disable the account at the identity provider
  --active              Re-enable a disabled account
  --update              Update an existing user
  --upsert              Create if absent, succeed silently if present
  --help, -h            Show this help
`;

function parseArgs(argv: string[]): Options {
  const o: Options = {
    email: '', passwordStdin: false, generatePassword: false,
    inactive: false, active: false, update: false, upsert: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`Missing value for ${a}`);
      i++;
      return v;
    };
    switch (a) {
      case '--email': o.email = value(); break;
      case '--password-stdin': o.passwordStdin = true; break;
      case '--generate-password': o.generatePassword = true; break;
      case '--inactive': o.inactive = true; break;
      case '--active': o.active = true; break;
      case '--update': o.update = true; break;
      case '--upsert': o.upsert = true; break;
      case '--help': case '-h': process.stdout.write(USAGE); process.exit(0);
      default: throw new Error(`Unknown flag: ${a}`);
    }
  }
  return o;
}

/**
 * Read the password from stdin's FIRST LINE.
 *
 * A password must never travel in argv: `ps` shows a process's command line to
 * every other user on the host, `docker inspect`/`container inspect` keep it as
 * long as the container record lives, and the caller's shell records it in
 * history. Stdin has none of those properties.
 */
async function readPasswordFromStdin(): Promise<string> {
  // Stop at the first newline rather than draining to EOF: a password is one
  // line, and waiting for the stream to close would hang an interactive run
  // (`docker exec -it … --password-stdin`) after the user pressed Enter, until
  // they thought to send Ctrl-D.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const buf = Buffer.from(chunk);
    chunks.push(buf);
    if (buf.includes(0x0a)) break;
  }
  // split() on empty input yields [''], but noUncheckedIndexedAccess types the
  // index access as possibly-undefined regardless — empty stdin is a refusal
  // either way, two lines down.
  const first = Buffer.concat(chunks).toString('utf8').split('\n', 1)[0] ?? '';
  const password = first.replace(/\r$/, '');
  if (!password) throw new Error('--password-stdin was given but stdin carried no password');
  if (password.length < 8) throw new Error('Password must be at least 8 characters long');
  return password;
}

/** Same shape the old CLI produced: 16 base64 chars from 12 random bytes. */
function generatePassword(): string {
  return crypto.randomBytes(12).toString('base64');
}

function validate(o: Options): void {
  if (!o.email) throw new Error('--email is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)) {
    throw new Error(`invalid email format: ${o.email}`);
  }
  if (o.passwordStdin && o.generatePassword) {
    throw new Error('--password-stdin and --generate-password are mutually exclusive');
  }
  if (o.update && o.upsert) {
    throw new Error('--update and --upsert are mutually exclusive');
  }
  if (o.inactive && o.active) {
    throw new Error('--inactive and --active are mutually exclusive');
  }
}

/**
 * The issuer this knowledge base trusts, and the administrator credentials for
 * it — refusing, with the reason, wherever the answer is not this command's to
 * give. An `oidc` issuer is somebody else's directory: Semiont has no standing
 * to create accounts in it, and pretending otherwise would fail at the API
 * rather than here, where the operator can read why.
 */
function keycloakTarget(identity: { type: string; issuer: string } | undefined): {
  issuer: string; username: string; password: string;
} {
  if (!identity) {
    throw new Error(
      'This knowledge base configures no identity provider — add an [identity] section before creating users.',
    );
  }
  if (identity.type !== 'keycloak') {
    throw new Error(
      `Identity type "${identity.type}" is an issuer Semiont does not administer. ` +
        `Create the account at ${identity.issuer}, then it can sign in here.`,
    );
  }
  const username = process.env.KC_BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.KC_BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'KC_BOOTSTRAP_ADMIN_USERNAME and KC_BOOTSTRAP_ADMIN_PASSWORD must both be set to administer the realm.',
    );
  }
  return { issuer: identity.issuer, username, password };
}

async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  validate(o);

  // `null`: this bin is exec'd INSIDE the gateway container
  // (`container exec semiont-gateway semiont-useradd`), which mounts no
  // knowledge base and sets no SEMIONT_ROOT. The staged ~/.semiontconfig is
  // the config, and the loader reads it either way.
  const config = loadEnvironmentConfig(null);
  const target = keycloakTarget(config.services.identity);
  const keycloak = await KeycloakAdminApi.connect(target.issuer, target.username, target.password);

  const account = await keycloak.findUserByEmail(o.email);

  let password: string | undefined;
  if (o.generatePassword) {
    password = generatePassword();
    // Printed once and never stored: the caller's only chance to capture it.
    process.stdout.write(`Generated password: ${password}\n`);
  } else if (o.passwordStdin) {
    password = await readPasswordFromStdin();
  } else if (!account) {
    throw new Error('Password required: use --password-stdin or --generate-password');
  }

  if (account && o.upsert) {
    process.stdout.write(`User already exists: ${o.email}\n`);
    return 0;
  }
  if (account && !o.update) {
    throw new Error(
      `User ${o.email} already exists. Use --update to modify or --upsert to skip silently.`,
    );
  }
  if (!account && o.update) {
    throw new Error(`User ${o.email} not found. Remove --update to create a new user.`);
  }

  // Whether the person may sign in is the issuer's to hold, so it is written
  // there and nowhere else. Absent both flags this command does not touch the
  // account's state.
  //
  // Nothing here sets a display name. The realm requires `firstName` and
  // `lastName`, so Keycloak collects them from the person at first sign-in —
  // see keycloakUserProfile in the launcher's identity.go for why that is the
  // person's job and not an administrator's.
  let subject: string;
  if (account) {
    if (password) await keycloak.setPassword(account.id, password);
    if (o.inactive || o.active) await keycloak.setEnabled(account.id, o.active);
    subject = account.id;
  } else {
    subject = await keycloak.createUser(o.email, password!, !o.inactive);
  }

  process.stdout.write(`${account ? 'User updated' : 'User created'}: ${o.email}\n`);
  process.stdout.write(`  Subject: ${subject}\n`);
  if (o.inactive) process.stdout.write('  Disabled at the identity provider\n');
  if (o.active) process.stdout.write('  Enabled at the identity provider\n');
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
