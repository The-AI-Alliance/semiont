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
 * 3. Hash password with bcrypt
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
 *
 * Security:
 * - Passwords hashed with bcrypt (cost factor 12)
 * - Minimum password length: 8 characters
 * - Generated passwords: 16+ characters
 * - Provider set to 'password' for password users
 */

import { z } from 'zod';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema } from '../base-options-schema.js';
import { printInfo, printSuccess, printError } from '../io/cli-logger.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

export const UseraddOptionsSchema = BaseOptionsSchema.extend({
  email: z.string().email(),
  name: z.string().optional(),
  password: z.string().optional(),
  generatePassword: z.boolean().default(false),
  admin: z.boolean().default(false),
  moderator: z.boolean().default(false),
  inactive: z.boolean().default(false),
  update: z.boolean().default(false),
});

export type UseraddOptions = z.output<typeof UseraddOptionsSchema>;

// =====================================================================
// VALIDATION HELPERS
// =====================================================================

function validateEmail(email: string): void {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error(`Invalid email format: ${email}`);
  }

  if (!email.includes('@')) {
    throw new Error('Invalid email: missing @ symbol');
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
  const prisma = new PrismaClient();

  try {
    // Validate email
    validateEmail(options.email);
    const domain = extractDomain(options.email);

    // Handle password
    let password: string;
    let generatedPassword: string | undefined;

    if (options.generatePassword) {
      password = generatePassword();
      generatedPassword = password;
      if (!options.quiet) {
        printInfo(`Generated password: ${password}`);
      }
    } else if (options.password) {
      password = options.password;
      validatePassword(password);
    } else {
      throw new Error('Password required: use --password or --generate-password');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email: options.email }
    });

    let user;

    if (existingUser) {
      if (!options.update) {
        throw new Error(`User ${options.email} already exists. Use --update to modify.`);
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
          passwordHash,
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
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (!options.quiet) {
      printError(`Failed to add user: ${errorMessage}`);
    }

    return {
      command: 'useradd',
      environment: options.environment!,
      timestamp: new Date(),
      summary: {
        succeeded: 0,
        failed: 1,
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
        success: false,
        error: errorMessage,
        duration
      }],
      duration
    };
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
    },
    aliases: {
      '-e': '--email',
      '-p': '--password',
      '-g': '--generate-password',
    },
  })
  .schema(UseraddOptionsSchema)
  .handler(useradd)
  .build();
