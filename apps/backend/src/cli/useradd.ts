/**
 * Create or update a user. Invoked inside the backend container by
 * `semiont useradd`, which execs it and passes every flag through verbatim.
 *
 * (No shebang — tsup's `banner` adds one to every entry.)
 *
 * Why this lives in the backend rather than the launcher: creating a user is a
 * schema-shaped operation. Two columns carry NO database-side default —
 *
 *   "id"        TEXT NOT NULL          -- @default(cuid()), applied client-side
 *   "updatedAt" TIMESTAMP(3) NOT NULL  -- @updatedAt, applied client-side
 *
 * — so a writer outside Prisma has to generate a cuid, supply updatedAt, know the
 * physical column names, and match argon2's PHC parameters. Each is doable; the
 * durable cost is that a future migration adding a NOT NULL column breaks such a
 * writer SILENTLY, discovered the next time someone creates a user. Here, the
 * generated client changes with the schema and `tsc` fails in CI.
 *
 * It also keeps the launcher technology-agnostic: it runs containers and decides
 * which stack is meant. It does not need to know that postgres, argon2, or cuids
 * exist.
 *
 * DATABASE_URL is derived here, not inherited: `container exec` starts a process
 * from the IMAGE's env, so nothing the CMD exported is visible to it (verified).
 * That is why databaseUrlFrom is a standalone helper.
 */

import * as crypto from 'crypto';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnvironmentConfig } from '@semiont/core/node';
import { databaseUrlFrom } from '../utils/database-url';

interface Options {
  email: string;
  passwordStdin: boolean;
  generatePassword: boolean;
  name?: string;
  admin: boolean;
  moderator: boolean;
  inactive: boolean;
  update: boolean;
  upsert: boolean;
}

const USAGE = `Usage: semiont-useradd --email <email> (--password-stdin | --generate-password) [options]

  --email <email>       User email address (required)
  --password-stdin      Read the password from stdin, first line (min 8 chars)
  --generate-password   Generate a random password (printed once)
  --name <name>         Display name
  --admin               Grant admin privileges
  --moderator           Grant moderator privileges
  --inactive            Create the user inactive
  --update              Update an existing user
  --upsert              Create if absent, succeed silently if present
  --help, -h            Show this help
`;

function parseArgs(argv: string[]): Options {
  const o: Options = {
    email: '', passwordStdin: false, generatePassword: false, admin: false,
    moderator: false, inactive: false, update: false, upsert: false,
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
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
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

function domainOf(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[1]) {
    throw new Error(`Cannot extract domain from email: ${email}`);
  }
  return parts[1];
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
}

async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  validate(o);

  const projectRoot = process.env.SEMIONT_ROOT;
  if (!projectRoot) {
    throw new Error('SEMIONT_ROOT is not set — cannot locate the knowledge base config');
  }
  const config = loadEnvironmentConfig(projectRoot, process.env.SEMIONT_ENV ?? 'local');

  // An explicit DATABASE_URL still wins, matching the container CMD's precedence.
  const connectionString = process.env.DATABASE_URL || databaseUrlFrom(config);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const existing = await prisma.user.findUnique({ where: { email: o.email } });

    let passwordHash: string | undefined;
    if (o.generatePassword) {
      const generated = generatePassword();
      passwordHash = await argon2.hash(generated);
      // Printed once and never stored: the caller's only chance to capture it.
      process.stdout.write(`Generated password: ${generated}\n`);
    } else if (o.passwordStdin) {
      passwordHash = await argon2.hash(await readPasswordFromStdin());
    } else if (!existing) {
      throw new Error('Password required: use --password-stdin or --generate-password');
    }

    if (existing) {
      if (o.upsert) {
        process.stdout.write(`User already exists: ${o.email}\n`);
        return 0;
      }
      if (!o.update) {
        throw new Error(
          `User ${o.email} already exists. Use --update to modify or --upsert to skip silently.`,
        );
      }
      await prisma.user.update({
        where: { email: o.email },
        data: {
          ...(passwordHash ? { passwordHash } : {}),
          ...(o.name !== undefined ? { name: o.name } : {}),
          ...(o.admin ? { isAdmin: true } : {}),
          ...(o.moderator ? { isModerator: true } : {}),
          ...(o.inactive ? { isActive: false } : {}),
        },
      });
      process.stdout.write(`User updated: ${o.email}\n`);
      return 0;
    }

    if (o.update) {
      throw new Error(`User ${o.email} not found. Remove --update to create a new user.`);
    }

    await prisma.user.create({
      data: {
        email: o.email,
        name: o.name ?? null,
        // provider/providerId must match what POST /api/tokens/password looks
        // for: it rejects any account whose provider is not 'password'.
        provider: 'password',
        providerId: o.email,
        passwordHash: passwordHash!,
        domain: domainOf(o.email),
        isActive: !o.inactive,
        isAdmin: o.admin,
        isModerator: o.moderator,
      },
    });
    process.stdout.write(`User created: ${o.email}\n`);
    if (o.admin) process.stdout.write('  Role: Admin\n');
    if (o.moderator) process.stdout.write('  Role: Moderator\n');
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
