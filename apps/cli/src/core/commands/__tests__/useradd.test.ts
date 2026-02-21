/**
 * Integration tests for the useradd command
 * Tests user creation with password authentication (TDD)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useradd, type UseraddOptions } from '../useradd';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

// Mock Prisma client for testing
const prisma = new PrismaClient();

// Helper to create complete UseraddOptions with defaults
function createUseraddOptions(partial: Partial<UseraddOptions> = {}): UseraddOptions {
  return {
    email: 'test@example.com',
    name: undefined,
    password: undefined,
    generatePassword: false,
    admin: false,
    moderator: false,
    inactive: false,
    update: false,
    verbose: false,
    dryRun: false,
    quiet: true,
    output: 'summary',
    forceDiscovery: false,
    environment: 'local',
    ...partial
  };
}

describe('useradd command', () => {
  beforeEach(async () => {
    // Clean up any test users before each test
    await prisma.user.deleteMany({
      where: {
        email: {
          contains: '@example.com'
        }
      }
    });
  });

  afterEach(async () => {
    // Clean up test users after each test
    await prisma.user.deleteMany({
      where: {
        email: {
          contains: '@example.com'
        }
      }
    });
  });

  describe('user creation with password', () => {
    it('should create user with provided password', async () => {
      const options = createUseraddOptions({
        email: 'newuser@example.com',
        password: 'testpass123'
      });

      const result = await useradd(options);

      expect(result.results[0].success).toBe(true);

      // Verify user was created in database
      const user = await prisma.user.findUnique({
        where: { email: 'newuser@example.com' }
      });

      expect(user).not.toBeNull();
      expect(user?.email).toBe('newuser@example.com');
      expect(user?.provider).toBe('password');
      expect(user?.providerId).toBe('newuser@example.com');
      expect(user?.passwordHash).not.toBeNull();
      expect(user?.isAdmin).toBe(false);
      expect(user?.isActive).toBe(true);
      expect(user?.domain).toBe('example.com');
    });

    it('should hash password using bcrypt', async () => {
      const password = 'mypassword123';
      const options = createUseraddOptions({
        email: 'hashtest@example.com',
        password
      });

      await useradd(options);

      const user = await prisma.user.findUnique({
        where: { email: 'hashtest@example.com' }
      });

      expect(user?.passwordHash).not.toBe(password);

      // Verify bcrypt hash is valid
      const isValid = await bcrypt.compare(password, user!.passwordHash!);
      expect(isValid).toBe(true);
    });
  });

  describe('generated password', () => {
    it('should create user with generated password', async () => {
      const options = createUseraddOptions({
        email: 'generated@example.com',
        generatePassword: true
      });

      const result = await useradd(options);

      expect(result.results[0].success).toBe(true);
      expect(result.results[0].metadata?.generatedPassword).toBeDefined();
      expect(result.results[0].metadata?.generatedPassword?.length).toBeGreaterThanOrEqual(16);

      const user = await prisma.user.findUnique({
        where: { email: 'generated@example.com' }
      });

      expect(user?.passwordHash).not.toBeNull();
    });

    it('should generate password of at least 16 characters', async () => {
      const options = createUseraddOptions({
        email: 'longpass@example.com',
        generatePassword: true
      });

      const result = await useradd(options);

      expect(result.results[0].metadata?.generatedPassword?.length).toBeGreaterThanOrEqual(16);
    });
  });

  describe('admin flag', () => {
    it('should set isAdmin=true when --admin flag is provided', async () => {
      const options = createUseraddOptions({
        email: 'admin@example.com',
        password: 'adminpass',
        admin: true
      });

      await useradd(options);

      const user = await prisma.user.findUnique({
        where: { email: 'admin@example.com' }
      });

      expect(user?.isAdmin).toBe(true);
    });

    it('should set isAdmin=false by default', async () => {
      const options = createUseraddOptions({
        email: 'regular@example.com',
        password: 'regularpass'
      });

      await useradd(options);

      const user = await prisma.user.findUnique({
        where: { email: 'regular@example.com' }
      });

      expect(user?.isAdmin).toBe(false);
    });
  });

  describe('moderator flag', () => {
    it('should set isModerator=true when --moderator flag is provided', async () => {
      const options = createUseraddOptions({
        email: 'moderator@example.com',
        password: 'modpass123',
        moderator: true
      });

      await useradd(options);

      const user = await prisma.user.findUnique({
        where: { email: 'moderator@example.com' }
      });

      expect(user?.isModerator).toBe(true);
    });
  });

  describe('duplicate email handling', () => {
    it('should throw error when email exists without --update flag', async () => {
      // Create initial user
      const initialOptions = createUseraddOptions({
        email: 'duplicate@example.com',
        password: 'password1'
      });
      await useradd(initialOptions);

      // Try to create again without update flag
      const duplicateOptions = createUseraddOptions({
        email: 'duplicate@example.com',
        password: 'password2'
      });

      await expect(useradd(duplicateOptions)).rejects.toThrow(/already exists/);
    });
  });

  describe('update mode', () => {
    it('should update existing user password with --update flag', async () => {
      // Create initial user
      const initialOptions = createUseraddOptions({
        email: 'updatetest@example.com',
        password: 'oldpassword'
      });
      await useradd(initialOptions);

      const oldUser = await prisma.user.findUnique({
        where: { email: 'updatetest@example.com' }
      });
      const oldHash = oldUser?.passwordHash;

      // Update password
      const updateOptions = createUseraddOptions({
        email: 'updatetest@example.com',
        password: 'newpassword',
        update: true
      });
      await useradd(updateOptions);

      const updatedUser = await prisma.user.findUnique({
        where: { email: 'updatetest@example.com' }
      });

      expect(updatedUser?.passwordHash).not.toBe(oldHash);

      // Verify new password works
      const isValid = await bcrypt.compare('newpassword', updatedUser!.passwordHash!);
      expect(isValid).toBe(true);
    });

    it('should update user roles with --update flag', async () => {
      // Create regular user
      const initialOptions = createUseraddOptions({
        email: 'roleupdate@example.com',
        password: 'password1'
      });
      await useradd(initialOptions);

      // Update to admin
      const updateOptions = createUseraddOptions({
        email: 'roleupdate@example.com',
        update: true,
        admin: true
      });
      await useradd(updateOptions);

      const updatedUser = await prisma.user.findUnique({
        where: { email: 'roleupdate@example.com' }
      });

      expect(updatedUser?.isAdmin).toBe(true);
    });

    it('should throw error when updating non-existent user', async () => {
      const options = createUseraddOptions({
        email: 'nonexistent@example.com',
        password: 'password1',
        update: true
      });

      await expect(useradd(options)).rejects.toThrow(/not found/);
    });
  });

  describe('email validation', () => {
    it('should throw error for invalid email format', async () => {
      const options = createUseraddOptions({
        email: 'not-an-email',
        password: 'password1'
      });

      await expect(useradd(options)).rejects.toThrow(/invalid email/);
    });

    it('should throw error for missing @ symbol', async () => {
      const options = createUseraddOptions({
        email: 'nodomain.com',
        password: 'password1'
      });

      await expect(useradd(options)).rejects.toThrow(/invalid email/);
    });
  });

  describe('password validation', () => {
    it('should throw error when password is less than 8 characters', async () => {
      const options = createUseraddOptions({
        email: 'short@example.com',
        password: '1234567' // Only 7 chars
      });

      await expect(useradd(options)).rejects.toThrow(/at least 8 characters/);
    });

    it('should accept password with exactly 8 characters', async () => {
      const options = createUseraddOptions({
        email: 'eight@example.com',
        password: '12345678' // Exactly 8 chars
      });

      const result = await useradd(options);
      expect(result.results[0].success).toBe(true);
    });
  });

  describe('domain extraction', () => {
    it('should extract domain from email correctly', async () => {
      const options = createUseraddOptions({
        email: 'user@example.com',
        password: 'testpass123'
      });

      await useradd(options);

      const user = await prisma.user.findUnique({
        where: { email: 'user@example.com' }
      });

      expect(user?.domain).toBe('example.com');
    });
  });

  describe('inactive flag', () => {
    it('should set isActive=false when --inactive flag is provided', async () => {
      const options = createUseraddOptions({
        email: 'inactive@example.com',
        password: 'password1',
        inactive: true
      });

      await useradd(options);

      const user = await prisma.user.findUnique({
        where: { email: 'inactive@example.com' }
      });

      expect(user?.isActive).toBe(false);
    });
  });

  describe('user name', () => {
    it('should set name when --name flag is provided', async () => {
      const options = createUseraddOptions({
        email: 'named@example.com',
        password: 'password1',
        name: 'John Doe'
      });

      await useradd(options);

      const user = await prisma.user.findUnique({
        where: { email: 'named@example.com' }
      });

      expect(user?.name).toBe('John Doe');
    });

    it('should leave name null when not provided', async () => {
      const options = createUseraddOptions({
        email: 'noname@example.com',
        password: 'password1'
      });

      await useradd(options);

      const user = await prisma.user.findUnique({
        where: { email: 'noname@example.com' }
      });

      expect(user?.name).toBeNull();
    });
  });
});
