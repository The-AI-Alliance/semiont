import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateData, JWTTokenSchema } from '@semiont/api-client';
import {
  ImageURLSchema,
  OAuthUserSchema,
  sanitizeImageURL,
} from '@semiont/react-ui';

// Use environment variables for URLs
const getFrontendUrl = () => 'http://localhost:3000';

describe('Validation Library (Native JS)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ImageURLSchema', () => {
    it('should validate secure image URLs with extensions', () => {
      const validImageUrls = [
        'https://example.com/image.jpg',
        'https://example.com/photo.jpeg',
        'https://example.com/pic.png',
        'https://example.com/animation.gif',
        'https://example.com/modern.webp',
        'https://example.com/vector.svg',
        'https://example.com/favicon.ico',
      ];

      validImageUrls.forEach(url => {
        expect(() => ImageURLSchema.parse(url)).not.toThrow();
      });
    });

    it('should allow Google profile images without extensions', () => {
      const googleUrls = [
        'https://lh3.googleusercontent.com/a/profile-photo',
        'https://avatars.googleusercontent.com/user123',
      ];

      googleUrls.forEach(url => {
        expect(() => ImageURLSchema.parse(url)).not.toThrow();
      });
    });

    it('should allow GitHub avatar URLs', () => {
      const githubUrl = 'https://avatars.githubusercontent.com/u/123456?v=4';
      expect(() => ImageURLSchema.parse(githubUrl)).not.toThrow();
    });

    it('should allow localhost HTTP for development', () => {
      const localhostUrl = `${getFrontendUrl()}/image.jpg`;
      expect(() => ImageURLSchema.parse(localhostUrl)).not.toThrow();
    });

    it('should reject non-HTTPS URLs for external hosts', () => {
      const httpUrl = 'http://example.com/image.jpg';
      expect(() => ImageURLSchema.parse(httpUrl)).toThrow('External images must use HTTPS');
    });

    it('should reject URLs with suspicious patterns', () => {
      const suspiciousUrls = [
        'https://example.com/javascript:alert(1).jpg',
        'https://example.com/data:text/html,<script>.jpg',
        'https://example.com/image.jpg?<script>alert(1)</script>',
        'https://example.com/image.jpg?onerror=alert(1)',
        'https://example.com/image.jpg?onload=evil()',
        'https://example.com/image.jpg?onclick=hack()',
      ];

      suspiciousUrls.forEach(url => {
        expect(() => ImageURLSchema.parse(url)).toThrow('Invalid or potentially unsafe image URL');
      });
    });

    it('should reject URLs without image extensions or known hosts', () => {
      const nonImageUrls = [
        'https://example.com/document.pdf',
        'https://example.com/video.mp4',
        'https://example.com/audio.mp3',
        'https://example.com/text.txt',
        'https://example.com/script.js',
        'https://example.com/page',
      ];

      nonImageUrls.forEach(url => {
        expect(() => ImageURLSchema.parse(url)).toThrow('URL must point to an image file');
      });
    });

    it('should handle case insensitive validation', () => {
      const mixedCaseUrls = [
        'https://example.com/IMAGE.JPG',
        'https://example.com/Photo.PNG',
        'https://LH3.GOOGLEUSERCONTENT.COM/profile',
      ];

      mixedCaseUrls.forEach(url => {
        expect(() => ImageURLSchema.parse(url)).not.toThrow();
      });
    });

    it('should use safeParse correctly', () => {
      const validUrl = 'https://example.com/image.jpg';
      const result = ImageURLSchema.safeParse(validUrl);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(validUrl);
      }

      const invalidUrl = 'http://example.com/image.jpg';
      const errorResult = ImageURLSchema.safeParse(invalidUrl);
      expect(errorResult.success).toBe(false);
      if (!errorResult.success) {
        expect(errorResult.error).toContain('HTTPS');
      }
    });
  });

  describe('JWTTokenSchema', () => {
    it('should validate properly formatted JWT tokens', () => {
      const validTokens = [
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.signature',
        'header.payload.signature',
        'a.b.c',
        'header.payload.', // Empty signature allowed
      ];

      validTokens.forEach(token => {
        expect(() => JWTTokenSchema.parse(token)).not.toThrow();
      });
    });

    it('should reject malformed JWT tokens', () => {
      const invalidTokens = [
        { token: 'not.a.jwt.token', error: 'Invalid JWT token format' },
        { token: 'onlyonepart', error: 'Invalid JWT token format' },
        { token: 'two.parts', error: 'Invalid JWT token format' },
        { token: 'header.payload', error: 'Invalid JWT token format' },
        { token: '.payload.signature', error: 'Invalid JWT token format' },
        { token: 'header..signature', error: 'Invalid JWT token format' },
        { token: 'header payload signature', error: 'Invalid JWT token format' },
        { token: '', error: 'Token is required' },
      ];

      invalidTokens.forEach(({ token, error }) => {
        expect(() => JWTTokenSchema.parse(token)).toThrow(error);
      });
    });

    it('should reject empty tokens', () => {
      expect(() => JWTTokenSchema.parse('')).toThrow('Token is required');
    });

    it('should reject non-string tokens', () => {
      expect(() => JWTTokenSchema.parse(123)).toThrow('Token must be a string');
      expect(() => JWTTokenSchema.parse(null)).toThrow('Token must be a string');
      expect(() => JWTTokenSchema.parse(undefined)).toThrow('Token must be a string');
    });

    it('should use safeParse correctly', () => {
      const validToken = 'header.payload.signature';
      const result = JWTTokenSchema.safeParse(validToken);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(validToken);
      }

      const invalidToken = 'invalid';
      const errorResult = JWTTokenSchema.safeParse(invalidToken);
      expect(errorResult.success).toBe(false);
      if (!errorResult.success) {
        expect(errorResult.error).toContain('Invalid JWT token format');
      }
    });
  });

  describe('OAuthUserSchema', () => {
    const validUser = {
      id: 'user123',
      email: 'user@example.com',
      name: 'John Doe',
      image: 'https://example.com/avatar.jpg',
      domain: 'example.com',
      isAdmin: false,
      isModerator: false,
    };

    it('should validate complete user objects', () => {
      expect(() => OAuthUserSchema.parse(validUser)).not.toThrow();
    });

    it('should handle null name', () => {
      const userWithNullName = { ...validUser, name: null };
      const result = OAuthUserSchema.parse(userWithNullName);
      expect(result.name).toBeNull();
    });

    it('should handle null image', () => {
      const userWithNullImage = { ...validUser, image: null };
      const result = OAuthUserSchema.parse(userWithNullImage);
      expect(result.image).toBeNull();
    });

    it('should handle undefined name (converts to null)', () => {
      const userWithUndefinedName = { ...validUser };
      delete (userWithUndefinedName as any).name;
      const result = OAuthUserSchema.parse(userWithUndefinedName);
      expect(result.name).toBeUndefined();
    });

    it('should require mandatory fields', () => {
      const requiredFields = [
        { field: 'id', error: 'User ID is required' },
        { field: 'email', error: 'email address is required' },
        { field: 'domain', error: 'Domain is required' },
        { field: 'isAdmin', error: 'isAdmin must be a boolean' },
        { field: 'isModerator', error: 'isModerator must be a boolean' },
      ];

      requiredFields.forEach(({ field, error }) => {
        const invalidUser = { ...validUser };
        delete invalidUser[field as keyof typeof invalidUser];
        expect(() => OAuthUserSchema.parse(invalidUser)).toThrow(error);
      });
    });

    it('should validate email field', () => {
      const userWithInvalidEmail = { ...validUser, email: 'invalid-email' };
      expect(() => OAuthUserSchema.parse(userWithInvalidEmail)).toThrow('email address is required');
    });

    it('should require non-empty required string fields', () => {
      const emptyStringFields = [
        { ...validUser, id: '' },
        { ...validUser, domain: '' },
      ];

      emptyStringFields.forEach(user => {
        expect(() => OAuthUserSchema.parse(user)).toThrow();
      });
    });

    it('should validate isAdmin as boolean', () => {
      const invalidBooleanValues = [
        { data: { ...validUser, isAdmin: 'true' }, error: 'isAdmin must be a boolean' },
        { data: { ...validUser, isAdmin: 1 }, error: 'isAdmin must be a boolean' },
        { data: { ...validUser, isAdmin: null }, error: 'isAdmin must be a boolean' },
        { data: { ...validUser, isAdmin: undefined }, error: 'isAdmin must be a boolean' },
      ];

      invalidBooleanValues.forEach(({ data, error }) => {
        expect(() => OAuthUserSchema.parse(data)).toThrow(error);
      });
    });

    it('should use safeParse correctly', () => {
      const result = OAuthUserSchema.safeParse(validUser);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(validUser.id);
        expect(result.data.email).toBe(validUser.email);
      }

      const invalidUser = { ...validUser, email: 'invalid' };
      const errorResult = OAuthUserSchema.safeParse(invalidUser);
      expect(errorResult.success).toBe(false);
      if (!errorResult.success) {
        expect(errorResult.error).toContain('email');
      }
    });
  });

  describe('sanitizeImageURL', () => {
    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should return sanitized valid image URLs', () => {
      const validUrls = [
        'https://example.com/image.jpg',
        'https://example.com/image.jpg?size=large',
        'https://lh3.googleusercontent.com/profile-photo',
      ];

      validUrls.forEach(url => {
        const result = sanitizeImageURL(url);
        expect(result).toBeTruthy();
        expect(result).toMatch(/^https:\/\//);
      });
    });

    it('should remove hash fragments from URLs', () => {
      const urlWithHash = 'https://example.com/image.jpg#fragment';
      const result = sanitizeImageURL(urlWithHash);
      expect(result).toBe('https://example.com/image.jpg');
    });

    it('should preserve query parameters', () => {
      const urlWithQuery = 'https://example.com/image.jpg?size=large&format=webp';
      const result = sanitizeImageURL(urlWithQuery);
      expect(result).toBe('https://example.com/image.jpg?size=large&format=webp');
    });

    it('should return null for invalid URLs', () => {
      const invalidUrls = [
        'not-a-url',
        'http://example.com/unsafe.jpg',
        'https://example.com/script.js',
        'javascript:alert(1)',
      ];

      invalidUrls.forEach(url => {
        const result = sanitizeImageURL(url);
        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalled();
      });
    });

    it('should handle malformed URLs gracefully', () => {
      const result = sanitizeImageURL('ht://invalid');
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should reconstruct URL with only safe components', () => {
      const complexUrl = 'https://user:pass@example.com:8080/image.jpg?query=value#hash';
      const result = sanitizeImageURL(complexUrl);
      // Should remove user:pass, port, and hash, keep protocol, hostname, pathname, search
      expect(result).toBe('https://example.com/image.jpg?query=value');
    });
  });

  describe('validateData', () => {
    it('should return success for valid data', () => {
      const validToken = 'header.payload.signature';
      const result = validateData(JWTTokenSchema, validToken);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(validToken);
      }
    });

    it('should return error for invalid data', () => {
      const invalidToken = 'invalid';
      const result = validateData(JWTTokenSchema, invalidToken);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid JWT token format');
      }
    });

    it('should handle complex object validation', () => {
      const validUser = {
        id: 'user123',
        email: 'user@example.com',
        name: 'John Doe',
        image: 'https://example.com/avatar.jpg',
        domain: 'example.com',
        isAdmin: false,
        isModerator: false,
      };

      const result = validateData(OAuthUserSchema, validUser);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('user123');
        expect(result.data.email).toBe('user@example.com');
      }
    });

    it('should handle validation errors', () => {
      const invalidUser = {
        id: '',
        email: 'invalid-email',
        domain: 'example.com',
        isAdmin: false,
        isModerator: false,
      };

      const result = validateData(OAuthUserSchema, invalidUser);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeTruthy();
      }
    });
  });

  describe('Edge Cases and Security', () => {
    it('should handle null and undefined inputs safely', () => {
      const nullResult = validateData(JWTTokenSchema, null);
      expect(nullResult.success).toBe(false);

      const undefinedResult = validateData(JWTTokenSchema, undefined);
      expect(undefinedResult.success).toBe(false);
    });

    it('should handle XSS attempts in image URLs', () => {
      const xssAttempts = [
        'https://example.com/javascript:alert(1).jpg',
        'https://example.com/image.jpg?<script>alert(1)</script>',
        'https://example.com/image.jpg?onerror=alert(1)',
      ];

      xssAttempts.forEach(attempt => {
        const sanitized = sanitizeImageURL(attempt);
        expect(sanitized).toBeNull();
      });
    });

    it('should prevent prototype pollution in user objects', () => {
      const maliciousData = {
        __proto__: { polluted: true },
        constructor: { prototype: { polluted: true } },
        id: 'user123',
        email: 'user@example.com',
        domain: 'example.com',
        isAdmin: false,
        isModerator: false,
      };

      const result = validateData(OAuthUserSchema, maliciousData);
      expect(result.success).toBe(true);
      if (result.success) {
        // Should only contain the expected fields
        const keys = Object.keys(result.data);
        expect(keys).toContain('id');
        expect(keys).toContain('email');
        expect(keys).not.toContain('__proto__');
        expect(keys).not.toContain('constructor');
      }
    });
  });
});
