/**
 * User Add Command
 *
 * Creates or updates users with password authentication.
 * This command manages user accounts for password-based authentication,
 * complementing OAuth authentication methods.
 *
 * Workflow:
 * 1. Validate email format
 * 2. Validate or generate password
 * 3. Hash password with argon2
 * 4. Create or update user in database
 * 5. Output generated password if applicable
 *
 * Options:
 * - --email: User email address (required)
 * - --name: User display name
 * - --password: Password (prompts if not provided)
 * - --generate-password: Generate random 16-char password
 * - --admin: Grant admin privileges
 * - --moderator: Grant moderator privileges
 * - --inactive: Create inactive user
 * - --update: Update existing user
 * - --upsert: Create if absent, skip silently if already exists
 *
 * Security:
 * - Passwords hashed with argon2
 * - Minimum password length: 8 characters
 * - Generated passwords: 16+ characters
 * - Provider set to 'password' for password users
 */

import { z } from 'zod';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';
import * as path from 'path';
import { createRequire } from 'module';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { OpsOptionsSchema } from '../base-options-schema.js';
import { printInfo, printSuccess } from '../io/cli-logger.js';
import { loadEnvironmentConfig, findProjectRoot } from '../config-loader.js';

/**
 * Load PrismaClient from @semiont/backend's generated client.
 * When installed globally, the CLI's own @prisma/client has no generated output.
 * We resolve from the project's node_modules (same pattern as backend-paths.ts).
 * DATABASE_URL must be set in process.env before calling this.
 */
function loadPrismaClient(projectRoot: string): import('@prisma/client').PrismaClient {
  const req = createRequire(path.join(projectRoot, 'node_modules', '.package.json'));

  // Try loading from @semiont/backend's generated client first
  try {
    const backendPkgPath = req.resolve('@semiont/backend/package.json');
    const backendReq = createRequire(backendPkgPath);
    const { PrismaClient } = backendReq('@prisma/client');
    const { PrismaPg } = backendReq('@prisma/adapter-pg');
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    return new PrismaClient({ adapter });
  } catch {
    // Fall back to direct @prisma/client in project (monorepo workspace)
  }

  try {
    const { PrismaClient } = req('@prisma/client');
    const { PrismaPg } = req('@prisma/adapter-pg');
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    return new PrismaClient({ adapter });
  } catch {
    throw new Error(
      '@prisma/client not initialized. Run "semiont provision" first, or run "prisma generate" in the backend directory.'
    );
  }
}

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

export const UseraddOptionsSchema = OpsOptionsSchema.extend({
  email: z.string().email().min(1, 'Email is required'),
  name: z.string().optional(),
  password: z.string().optional(),
  generatePassword: z.boolean().default(false),
  admin: z.boolean().default(false),
  moderator: z.boolean().default(false),
  inactive: z.boolean().default(false),
  update: z.boolean().default(false),
  upsert: z.boolean().default(false),
});

export type UseraddOptions = z.output<typeof UseraddOptionsSchema>;

// =====================================================================
// VALIDATION HELPERS
// =====================================================================

function validateEmail(email: string): void {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error(`invalid email format: ${email}`);
  }

  if (!email.includes('@')) {
    throw new Error('invalid email: missing @ symbol');
  }
}

function validatePassword(password: string): void {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }
}

function extractDomain(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2) {
    throw new Error(`Cannot extract domain from email: ${email}`);
  }
  return parts[1];
}

function generatePassword(): string {
  // Generate 16-character base64 password
  return crypto.randomBytes(12).toString('base64');
}

// =====================================================================
// COMMAND IMPLEMENTATION
// =====================================================================

export async function useradd(options: UseraddOptions): Promise<CommandResults> {
  const startTime = Date.now();

  // Load DATABASE_URL from environment config
  const projectRoot = findProjectRoot();
  const environment = options.environment!;
  const envConfig = loadEnvironmentConfig(projectRoot, environment);
  const dbConfig = envConfig.services?.database;

  if (!dbConfig) {
    throw new Error('Database configuration not found in environment config');
  }

  const dbUser = dbConfig.user;
  const dbPassword = dbConfig.password;
  const dbName = dbConfig.name;
  const dbPort = dbConfig.port;
  const dbHost = dbConfig.host || 'localhost';

  if (!dbUser || !dbPassword || !dbName || !dbPort) {
    throw new Error('Incomplete database configuration: need user, password, name, and port');
  }

  const databaseUrl = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;

  process.env.DATABASE_URL = databaseUrl;
  const prisma = loadPrismaClient(projectRoot);

  try {
    // Validate email
    validateEmail(options.email);
    const domain = extractDomain(options.email);

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email: options.email }
    });

    // Handle password
    let password: string | undefined;
    let passwordHash: string | undefined;
    let generatedPassword: string | undefined;

    if (options.generatePassword) {
      password = generatePassword();
      generatedPassword = password;
      passwordHash = await argon2.hash(password);
      if (!options.quiet) {
        printInfo(`Generated password: ${password}`);
      }
    } else if (options.password) {
      password = options.password;
      validatePassword(password);
      passwordHash = await argon2.hash(password);
    } else if (!existingUser) {
      // Password required for new users
      throw new Error('Password required: use --password or --generate-password');
    }

    let user;

    if (existingUser) {
      if (options.upsert) {
        // User exists and --upsert was passed: treat as success, skip write
        if (!options.quiet) {
          printSuccess(`User already exists: ${options.email}`);
        }
        await prisma.$disconnect();
        return {
          command: 'useradd',
          environment: options.environment!,
          timestamp: new Date(),
          summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
          executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
          results: [{ entity: options.email, platform: 'posix', success: true, metadata: { userId: existingUser.id, email: existingUser.email, isAdmin: existingUser.isAdmin, isModerator: existingUser.isModerator, isActive: existingUser.isActive }, duration: Date.now() - startTime }],
          duration: Date.now() - startTime,
        };
      }
      if (!options.update) {
        throw new Error(`User ${options.email} already exists. Use --update to modify or --upsert to skip silently.`);
      }

      // Update existing user
      if (!options.quiet) {
        printInfo(`Updating user: ${options.email}`);
      }

      user = await prisma.user.update({
        where: { email: options.email },
        data: {
          ...(options.password || options.generatePassword ? { passwordHash } : {}),
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.admin !== undefined ? { isAdmin: options.admin } : {}),
          ...(options.moderator !== undefined ? { isModerator: options.moderator } : {}),
          ...(options.inactive !== undefined ? { isActive: !options.inactive } : {}),
        }
      });

      if (!options.quiet) {
        printSuccess(`User updated: ${options.email}`);
      }
    } else {
      if (options.update) {
        throw new Error(`User ${options.email} not found. Remove --update to create new user.`);
      }

      // Create new user
      if (!options.quiet) {
        printInfo(`Creating user: ${options.email}`);
      }

      user = await prisma.user.create({
        data: {
          email: options.email,
          name: options.name || null,
          provider: 'password',
          providerId: options.email,
          passwordHash: passwordHash!,
          domain,
          isActive: !options.inactive,
          isAdmin: options.admin,
          isModerator: options.moderator,
        }
      });

      if (!options.quiet) {
        printSuccess(`User created: ${options.email}`);
        if (options.admin) {
          printInfo('  Role: Admin');
        }
        if (options.moderator) {
          printInfo('  Role: Moderator');
        }
      }
    }

    const duration = Date.now() - startTime;

    return {
      command: 'useradd',
      environment: options.environment!,
      timestamp: new Date(),
      summary: {
        succeeded: 1,
        failed: 0,
        total: 1,
        warnings: 0
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun
      },
      results: [{
        entity: options.email,
        platform: 'posix',
        success: true,
        metadata: {
          userId: user.id,
          email: user.email,
          isAdmin: user.isAdmin,
          isModerator: user.isModerator,
          isActive: user.isActive,
          ...(generatedPassword ? { generatedPassword } : {})
        },
        duration
      }],
      duration
    };
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// =====================================================================
// COMMAND DEFINITION (for CLI)
// =====================================================================

export const useraddCommand = new CommandBuilder()
  .name('useradd')
  .description('Create or update user with password authentication')
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont useradd --email user@example.com --generate-password --admin',
    'semiont useradd --email user@example.com --password mypass123',
    'semiont useradd --email user@example.com --update --password newpass'
  )
  .args({
    args: {
      '--email': {
        type: 'string',
        description: 'User email address (required)',
      },
      '--name': {
        type: 'string',
        description: 'User display name',
      },
      '--password': {
        type: 'string',
        description: 'Password (prompts if not provided)',
      },
      '--generate-password': {
        type: 'boolean',
        description: 'Generate random 16-char password',
        default: false,
      },
      '--admin': {
        type: 'boolean',
        description: 'Grant admin privileges',
        default: false,
      },
      '--moderator': {
        type: 'boolean',
        description: 'Grant moderator privileges',
        default: false,
      },
      '--inactive': {
        type: 'boolean',
        description: 'Create inactive user',
        default: false,
      },
      '--update': {
        type: 'boolean',
        description: 'Update existing user',
        default: false,
      },
      '--upsert': {
        type: 'boolean',
        description: 'Create user if absent, skip silently if already exists',
        default: false,
      },
    },
    aliases: {
      '-p': '--password',
      '-g': '--generate-password',
    },
  })
  .schema(UseraddOptionsSchema)
  .handler(useradd)
  .build();
