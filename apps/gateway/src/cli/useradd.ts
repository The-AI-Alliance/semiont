/**
 * Create or update a user. Invoked inside the gateway container by
 * `semiont useradd`, which execs it and passes every flag through verbatim.
 *
 * (No shebang — tsup's `banner` adds one to every entry.)
 *
 * A user is two things, and this command writes both. The ACCOUNT lives at the
 * knowledge base's identity provider, which owns the credential, mints the
 * `sub` its tokens carry, and decides whether the person may sign in at all
 * (`--active` / `--inactive` set that there). The Semiont ROW carries what only
 * this knowledge base knows: `isAdmin`, `isModerator`, the display name. The row is
 * written through `provisionUser` — the same function the gateway runs when a
 * token arrives — so an account created here and one that simply signs in land
 * on the same row by the same rule.
 *
 * Pre-creating the row is not an optimization: `isAdmin` has nowhere else to
 * live, and a knowledge base whose first administrator could only be granted by
 * an existing administrator would have none.
 *
 * Why this lives in the gateway rather than the launcher: the row is
 * schema-shaped. Two columns carry NO database-side default —
 *
 *   "id"        TEXT NOT NULL          -- @default(cuid()), applied client-side
 *   "updatedAt" TIMESTAMP(3) NOT NULL  -- @updatedAt, applied client-side
 *
 * — so a writer outside Prisma has to generate a cuid, supply updatedAt and know
 * the physical column names. Each is doable; the durable cost is that a future
 * migration adding a NOT NULL column breaks such a writer SILENTLY, discovered
 * the next time someone creates a user. Here, the generated client changes with
 * the schema and `tsc` fails in CI. It also keeps the launcher
 * technology-agnostic: it runs containers and decides which stack is meant.
 *
 * DATABASE_URL is derived here, not inherited: `container exec` starts a process
 * from the IMAGE's env, so nothing the CMD exported is visible to it (verified).
 * That is why databaseUrlFrom is a standalone helper.
 */

import * as crypto from 'crypto';
import { loadEnvironmentConfig } from '@semiont/core/node';
import { DatabaseConnection } from '../db';
import { databaseUrlFrom } from '../utils/database-url';
import { KeycloakAdminApi } from '../identity/keycloak-admin';
import { provisionUser } from '../identity/principal';

interface Options {
  email: string;
  passwordStdin: boolean;
  generatePassword: boolean;
  name?: string;
  admin: boolean;
  moderator: boolean;
  active: boolean;
  inactive: boolean;
  update: boolean;
  upsert: boolean;
}

const USAGE = `Usage: semiont-useradd --email <email> [--password-stdin | --generate-password] [options]

Creates the account at this knowledge base's identity provider and the row that
carries its Semiont roles. Creating a user requires a password, so one of
--password-stdin or --generate-password. Updating an existing one does not: pass
--password-stdin only when the point is to CHANGE the password.

  --email <email>       User email address (required)
  --password-stdin      Read the password from stdin, first line (min 8 chars)
  --generate-password   Generate a random password (printed once)
  --name <name>         Display name
  --admin               Grant admin privileges
  --moderator           Grant moderator privileges
  --inactive            Disable the account at the identity provider
  --active              Re-enable a disabled account
  --update              Update an existing user
  --upsert              Create if absent, succeed silently if present
  --help, -h            Show this help
`;

function parseArgs(argv: string[]): Options {
  const o: Options = {
    email: '', passwordStdin: false, generatePassword: false, admin: false,
    moderator: false, inactive: false, active: false, update: false, upsert: false,
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
      case '--name': o.name = value(); break;
      case '--password-stdin': o.passwordStdin = true; break;
      case '--generate-password': o.generatePassword = true; break;
      case '--admin': o.admin = true; break;
      case '--moderator': o.moderator = true; break;
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

  // `null` for the same reason db-url.ts passes null: this bin is exec'd INSIDE
  // the gateway container (`container exec semiont-gateway semiont-useradd`),
  // which mounts no knowledge base and sets no SEMIONT_ROOT. The staged
  // ~/.semiontconfig is the config, and the loader reads it either way.
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
  // account's state, matching how the role flags behave: they grant when asked
  // and leave everything else alone.
  let subject: string;
  if (account) {
    if (password) await keycloak.setPassword(account.id, password);
    if (o.inactive || o.active) await keycloak.setEnabled(account.id, o.active);
    subject = account.id;
  } else {
    subject = await keycloak.createUser(o.email, password!, !o.inactive);
  }

  // An explicit DATABASE_URL still wins, matching the container CMD's
  // precedence; DatabaseConnection reads it from here, so deriving it into the
  // environment is what lets this command share the gateway's one client rather
  // than constructing a second with its own idea of the connection.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = databaseUrlFrom(config);
  }
  const prisma = DatabaseConnection.getClient();

  try {
    // `lastLogin: null` — this account has not signed in, and an administrator
    // creating it is not a sign-in.
    const user = await provisionUser({
      issuer: target.issuer,
      subject,
      email: o.email,
      ...(o.name !== undefined ? { name: o.name } : {}),
      lastLogin: null,
    });

    // Only what was asked for: the flags GRANT, matching what this command has
    // always done — there is no revocation flag, and inventing one silently
    // would be a surprise for anyone re-running it to change a display name.
    const roles = {
      ...(o.name !== undefined ? { name: o.name } : {}),
      ...(o.admin ? { isAdmin: true } : {}),
      ...(o.moderator ? { isModerator: true } : {}),
    };
    if (Object.keys(roles).length > 0) {
      await prisma.user.update({ where: { id: user.id }, data: roles });
    }

    process.stdout.write(`${account ? 'User updated' : 'User created'}: ${o.email}\n`);
    if (o.admin) process.stdout.write('  Role: Admin\n');
    if (o.moderator) process.stdout.write('  Role: Moderator\n');
    if (o.inactive) process.stdout.write('  Disabled at the identity provider\n');
    if (o.active) process.stdout.write('  Enabled at the identity provider\n');
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
