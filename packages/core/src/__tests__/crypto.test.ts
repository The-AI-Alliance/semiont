import { describe, it, expect } from 'vitest';
import { calculateChecksum, verifyChecksum, generateId, generateUuid, generateToken } from '../crypto';

describe('@semiont/core - crypto', () => {
  describe('calculateChecksum', () => {
    it('should calculate SHA-256 for string content', () => {
      const content = 'Hello, world!';
      const checksum = calculateChecksum(content);

      // Known SHA-256 hash for "Hello, world!"
      expect(checksum).toBe('315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3');
    });

    it('should calculate SHA-256 for Buffer content', () => {
      const content = Buffer.from('Test content');
      const checksum = calculateChecksum(content);

      expect(checksum).toHaveLength(64); // SHA-256 is 64 hex characters
      expect(/^[0-9a-f]{64}$/.test(checksum)).toBe(true);
    });

    it('should return consistent hashes for same content', () => {
      const content = 'Test content';
      const hash1 = calculateChecksum(content);
      const hash2 = calculateChecksum(content);

      expect(hash1).toBe(hash2);
    });

    it('should return different hashes for different content', () => {
      const content1 = 'Content A';
      const content2 = 'Content B';
      const hash1 = calculateChecksum(content1);
      const hash2 = calculateChecksum(content2);

      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty strings', () => {
      const checksum = calculateChecksum('');

      // Known SHA-256 hash for empty string
      expect(checksum).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('should handle unicode content', () => {
      const content = '你好世界 🌍';
      const checksum = calculateChecksum(content);

      expect(checksum).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(checksum)).toBe(true);
    });

    it('should match known SHA-256 test vectors', () => {
      // Test vector from NIST
      const content = 'abc';
      const checksum = calculateChecksum(content);

      expect(checksum).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
  });

  describe('verifyChecksum', () => {
    it('should return true for matching checksum', () => {
      const content = 'Test content';
      const checksum = calculateChecksum(content);
      const isValid = verifyChecksum(content, checksum);

      expect(isValid).toBe(true);
    });

    it('should return false for mismatched checksum', () => {
      const content = 'Test content';
      const wrongChecksum = 'abcdef1234567890';
      const isValid = verifyChecksum(content, wrongChecksum);

      expect(isValid).toBe(false);
    });

    it('should work with Buffer content', () => {
      const content = Buffer.from('Binary content');
      const checksum = calculateChecksum(content);
      const isValid = verifyChecksum(content, checksum);

      expect(isValid).toBe(true);
    });
  });

  describe('generateId', () => {
    it('should generate 12-character hex string', () => {
      const id = generateId();

      expect(id).toHaveLength(12);
      expect(/^[0-9a-f]{12}$/.test(id)).toBe(true);
    });

    it('should generate unique IDs', () => {
      const id1 = generateId();
      const id2 = generateId();
      const id3 = generateId();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it('should only contain hex characters', () => {
      const id = generateId();

      // Should only have 0-9 and a-f
      expect(/^[0-9a-f]+$/.test(id)).toBe(true);
      // Should not have uppercase or other characters
      expect(/[G-Z]/i.test(id)).toBe(false);
    });
  });

  describe('generateUuid', () => {
    it('should generate 32-character hex string', () => {
      const uuid = generateUuid();

      expect(uuid).toHaveLength(32);
      expect(/^[0-9a-f]{32}$/.test(uuid)).toBe(true);
    });

    it('should generate unique UUIDs', () => {
      const uuid1 = generateUuid();
      const uuid2 = generateUuid();
      const uuid3 = generateUuid();

      expect(uuid1).not.toBe(uuid2);
      expect(uuid2).not.toBe(uuid3);
      expect(uuid1).not.toBe(uuid3);
    });
  });

  describe('generateToken', () => {
    it('should generate base64url token', () => {
      const token = generateToken();

      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      // Base64url uses A-Za-z0-9_- (no +/=)
      expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
    });

    it('should respect custom byte length', () => {
      const token16 = generateToken(16);
      const token64 = generateToken(64);

      // Base64url encoding of N bytes produces roughly N*4/3 characters
      expect(token16.length).toBeLessThan(token64.length);
      expect(token16.length).toBeGreaterThan(16);
      expect(token64.length).toBeGreaterThan(64);
    });

    it('should generate unique tokens', () => {
      const token1 = generateToken();
      const token2 = generateToken();
      const token3 = generateToken();

      expect(token1).not.toBe(token2);
      expect(token2).not.toBe(token3);
      expect(token1).not.toBe(token3);
    });

    it('should use URL-safe characters', () => {
      const token = generateToken();

      // Should not contain + or / or =
      expect(token.includes('+')).toBe(false);
      expect(token.includes('/')).toBe(false);
      expect(token.includes('=')).toBe(false);
    });
  });
});
