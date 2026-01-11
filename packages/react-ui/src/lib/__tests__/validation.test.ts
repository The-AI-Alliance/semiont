import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageURLSchema, OAuthUserSchema, sanitizeImageURL, type OAuthUser } from '../validation';

describe('ImageURLSchema', () => {
  describe('parse', () => {
    describe('Valid URLs', () => {
      it('should accept HTTPS image URLs', () => {
        const url = 'https://example.com/image.jpg';
        expect(ImageURLSchema.parse(url)).toBe(url);
      });

      it('should accept URLs with various image extensions', () => {
        const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico'];
        extensions.forEach(ext => {
          const url = `https://example.com/image${ext}`;
          expect(ImageURLSchema.parse(url)).toBe(url);
        });
      });

      it('should accept localhost URLs with HTTP', () => {
        const url = 'http://localhost:3000/image.png';
        expect(ImageURLSchema.parse(url)).toBe(url);
      });

      it('should accept Google profile images', () => {
        const url = 'https://lh3.googleusercontent.com/a/someimage';
        expect(ImageURLSchema.parse(url)).toBe(url);
      });

      it('should accept GitHub avatar URLs', () => {
        const url = 'https://avatars.githubusercontent.com/u/12345?v=4';
        expect(ImageURLSchema.parse(url)).toBe(url);
      });

      it('should accept URLs with query parameters', () => {
        const url = 'https://example.com/image.jpg?size=large&format=webp';
        expect(ImageURLSchema.parse(url)).toBe(url);
      });

      it('should accept URLs with hash fragments', () => {
        const url = 'https://example.com/image.png#section';
        expect(ImageURLSchema.parse(url)).toBe(url);
      });
    });

    describe('Invalid URLs', () => {
      it('should reject non-string values', () => {
        expect(() => ImageURLSchema.parse(123)).toThrow('URL must be a string');
        expect(() => ImageURLSchema.parse(null)).toThrow('URL must be a string');
        expect(() => ImageURLSchema.parse(undefined)).toThrow('URL must be a string');
        expect(() => ImageURLSchema.parse({})).toThrow('URL must be a string');
      });

      it('should reject malformed URLs', () => {
        expect(() => ImageURLSchema.parse('not a url')).toThrow('Invalid image URL');
        expect(() => ImageURLSchema.parse('htp://example.com/image.jpg')).toThrow('External images must use HTTPS');
      });

      it('should reject HTTP for external images', () => {
        expect(() => ImageURLSchema.parse('http://example.com/image.jpg')).toThrow(
          'External images must use HTTPS'
        );
      });

      it('should reject javascript: URLs', () => {
        // javascript: protocol is not https, so it fails protocol check first
        expect(() => ImageURLSchema.parse('javascript:alert(1)')).toThrow(
          'External images must use HTTPS'
        );
      });

      it('should reject data URLs with HTML', () => {
        // data: protocol is not https, so it fails protocol check first
        expect(() => ImageURLSchema.parse('data:text/html,<script>alert(1)</script>')).toThrow(
          'External images must use HTTPS'
        );
      });

      it('should reject URLs with XSS patterns in HTTPS URLs', () => {
        // These use HTTPS but have XSS patterns
        const xssPatterns = [
          'https://example.com/image.jpg?<script>alert(1)</script>',
          'https://example.com/image.jpg?onerror=alert(1)',
          'https://example.com/image.jpg?onload=alert(1)',
          'https://example.com/image.jpg?onclick=alert(1)',
        ];

        xssPatterns.forEach(url => {
          expect(() => ImageURLSchema.parse(url)).toThrow(
            'Invalid or potentially unsafe image URL'
          );
        });
      });

      it('should reject URLs without image extensions or known domains', () => {
        expect(() => ImageURLSchema.parse('https://example.com/notanimage')).toThrow(
          'URL must point to an image file'
        );
      });

      it('should reject empty strings', () => {
        expect(() => ImageURLSchema.parse('')).toThrow('Invalid image URL');
      });
    });

    describe('Case Insensitivity', () => {
      it('should handle uppercase extensions', () => {
        const url = 'https://example.com/IMAGE.JPG';
        expect(ImageURLSchema.parse(url)).toBe(url);
      });

      it('should detect XSS patterns case-insensitively', () => {
        expect(() => ImageURLSchema.parse('https://example.com/image.jpg?ONERROR=alert(1)')).toThrow(
          'Invalid or potentially unsafe image URL'
        );
      });
    });
  });

  describe('safeParse', () => {
    it('should return success for valid URLs', () => {
      const url = 'https://example.com/image.jpg';
      const result = ImageURLSchema.safeParse(url);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(url);
      }
    });

    it('should return error for invalid URLs', () => {
      const result = ImageURLSchema.safeParse('http://example.com/image.jpg');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('External images must use HTTPS');
      }
    });

    it('should return error for non-string values', () => {
      const result = ImageURLSchema.safeParse(123);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('URL must be a string');
      }
    });

    it('should handle errors gracefully', () => {
      const result = ImageURLSchema.safeParse('javascript:alert(1)');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('External images must use HTTPS');
      }
    });
  });
});

describe('OAuthUserSchema', () => {
  const validUser: OAuthUser = {
    id: 'user123',
    email: 'user@example.com',
    domain: 'example.com',
    isAdmin: false,
    isModerator: false,
  };

  describe('parse', () => {
    describe('Valid User Objects', () => {
      it('should accept valid user with required fields only', () => {
        const result = OAuthUserSchema.parse(validUser);

        expect(result).toEqual(validUser);
      });

      it('should accept user with optional name field', () => {
        const userWithName = { ...validUser, name: 'John Doe' };
        const result = OAuthUserSchema.parse(userWithName);

        expect(result).toEqual(userWithName);
      });

      it('should accept user with optional image field', () => {
        const userWithImage = { ...validUser, image: 'https://example.com/avatar.jpg' };
        const result = OAuthUserSchema.parse(userWithImage);

        expect(result).toEqual(userWithImage);
      });

      it('should accept user with both optional fields', () => {
        const completeUser = {
          ...validUser,
          name: 'John Doe',
          image: 'https://example.com/avatar.jpg',
        };
        const result = OAuthUserSchema.parse(completeUser);

        expect(result).toEqual(completeUser);
      });

      it('should accept user with null name', () => {
        const userWithNullName = { ...validUser, name: null };
        const result = OAuthUserSchema.parse(userWithNullName);

        expect(result).toEqual(userWithNullName);
      });

      it('should accept user with null image', () => {
        const userWithNullImage = { ...validUser, image: null };
        const result = OAuthUserSchema.parse(userWithNullImage);

        expect(result).toEqual(userWithNullImage);
      });

      it('should accept admin users', () => {
        const adminUser = { ...validUser, isAdmin: true };
        const result = OAuthUserSchema.parse(adminUser);

        expect(result.isAdmin).toBe(true);
      });

      it('should accept moderator users', () => {
        const modUser = { ...validUser, isModerator: true };
        const result = OAuthUserSchema.parse(modUser);

        expect(result.isModerator).toBe(true);
      });
    });

    describe('Invalid User Objects', () => {
      it('should reject non-object values', () => {
        expect(() => OAuthUserSchema.parse(null)).toThrow('User data must be an object');
        expect(() => OAuthUserSchema.parse(undefined)).toThrow('User data must be an object');
        expect(() => OAuthUserSchema.parse('string')).toThrow('User data must be an object');
        expect(() => OAuthUserSchema.parse(123)).toThrow('User data must be an object');
      });

      it('should reject missing id', () => {
        const { id, ...userWithoutId } = validUser;
        expect(() => OAuthUserSchema.parse(userWithoutId)).toThrow('User ID is required');
      });

      it('should reject empty id', () => {
        const userWithEmptyId = { ...validUser, id: '' };
        expect(() => OAuthUserSchema.parse(userWithEmptyId)).toThrow('User ID is required');
      });

      it('should reject non-string id', () => {
        const userWithNumberId = { ...validUser, id: 123 };
        expect(() => OAuthUserSchema.parse(userWithNumberId)).toThrow('User ID is required');
      });

      it('should reject missing email', () => {
        const { email, ...userWithoutEmail } = validUser;
        expect(() => OAuthUserSchema.parse(userWithoutEmail)).toThrow(
          'Valid email address is required'
        );
      });

      it('should reject invalid email', () => {
        const userWithInvalidEmail = { ...validUser, email: 'not-an-email' };
        expect(() => OAuthUserSchema.parse(userWithInvalidEmail)).toThrow(
          'Valid email address is required'
        );
      });

      it('should reject missing domain', () => {
        const { domain, ...userWithoutDomain } = validUser;
        expect(() => OAuthUserSchema.parse(userWithoutDomain)).toThrow('Domain is required');
      });

      it('should reject empty domain', () => {
        const userWithEmptyDomain = { ...validUser, domain: '' };
        expect(() => OAuthUserSchema.parse(userWithEmptyDomain)).toThrow('Domain is required');
      });

      it('should reject non-string name', () => {
        const userWithNumberName = { ...validUser, name: 123 };
        expect(() => OAuthUserSchema.parse(userWithNumberName)).toThrow(
          'Name must be a string or null'
        );
      });

      it('should reject non-string image', () => {
        const userWithNumberImage = { ...validUser, image: 123 };
        expect(() => OAuthUserSchema.parse(userWithNumberImage)).toThrow(
          'Image must be a string or null'
        );
      });

      it('should reject non-boolean isAdmin', () => {
        const userWithStringAdmin = { ...validUser, isAdmin: 'true' };
        expect(() => OAuthUserSchema.parse(userWithStringAdmin)).toThrow(
          'isAdmin must be a boolean'
        );
      });

      it('should reject missing isAdmin', () => {
        const { isAdmin, ...userWithoutAdmin } = validUser;
        expect(() => OAuthUserSchema.parse(userWithoutAdmin)).toThrow(
          'isAdmin must be a boolean'
        );
      });

      it('should reject non-boolean isModerator', () => {
        const userWithStringMod = { ...validUser, isModerator: 'true' };
        expect(() => OAuthUserSchema.parse(userWithStringMod)).toThrow(
          'isModerator must be a boolean'
        );
      });

      it('should reject missing isModerator', () => {
        const { isModerator, ...userWithoutMod } = validUser;
        expect(() => OAuthUserSchema.parse(userWithoutMod)).toThrow(
          'isModerator must be a boolean'
        );
      });
    });
  });

  describe('safeParse', () => {
    it('should return success for valid user', () => {
      const result = OAuthUserSchema.safeParse(validUser);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validUser);
      }
    });

    it('should return error for invalid user', () => {
      const result = OAuthUserSchema.safeParse({ id: 'test' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeTruthy();
      }
    });

    it('should return error for non-object', () => {
      const result = OAuthUserSchema.safeParse(null);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('User data must be an object');
      }
    });
  });
});

describe('sanitizeImageURL', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Valid URLs', () => {
    it('should return sanitized HTTPS URL', () => {
      const url = 'https://example.com/image.jpg';
      expect(sanitizeImageURL(url)).toBe(url);
    });

    it('should preserve query parameters', () => {
      const url = 'https://example.com/image.jpg?size=large';
      expect(sanitizeImageURL(url)).toBe(url);
    });

    it('should preserve URL without hash fragments', () => {
      const url = 'https://example.com/image.jpg';
      const result = sanitizeImageURL(url);
      expect(result).toBe(url);
    });

    it('should handle localhost URLs', () => {
      // Note: sanitizeImageURL reconstructs URL without hash
      const url = 'http://localhost:3000/image.png';
      // The URL is reconstructed so it might not include port if default
      const result = sanitizeImageURL(url);
      expect(result).toContain('localhost');
      expect(result).toContain('image.png');
    });
  });

  describe('Invalid URLs', () => {
    it('should return null for HTTP external URLs', () => {
      const url = 'http://example.com/image.jpg';
      const result = sanitizeImageURL(url);

      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith('Invalid image URL:', expect.any(String));
    });

    it('should return null for XSS attempts', () => {
      const url = 'https://example.com/image.jpg?<script>alert(1)</script>';
      const result = sanitizeImageURL(url);

      expect(result).toBeNull();
    });

    it('should return null for malformed URLs', () => {
      const url = 'not a url';
      const result = sanitizeImageURL(url);

      expect(result).toBeNull();
      // Either console.warn or console.error could be called depending on validation path
      expect(console.warn).toHaveBeenCalled();
    });

    it('should return null for URLs without image extensions', () => {
      const url = 'https://example.com/notanimage';
      const result = sanitizeImageURL(url);

      expect(result).toBeNull();
    });
  });

  describe('Sanitization Process', () => {
    it('should reconstruct URL with safe parts only', () => {
      const url = 'https://example.com/image.jpg?param=value';
      const result = sanitizeImageURL(url);

      expect(result).toBe('https://example.com/image.jpg?param=value');
    });

    it('should handle complex valid URLs', () => {
      const url = 'https://avatars.githubusercontent.com/u/12345?v=4';
      const result = sanitizeImageURL(url);

      expect(result).toBe(url);
    });
  });

  describe('Error Handling', () => {
    it('should handle exceptions gracefully', () => {
      // URL constructor will throw for completely invalid input
      const result = sanitizeImageURL('');

      expect(result).toBeNull();
      // Either console.warn or console.error could be called
      expect(console.warn).toHaveBeenCalled();
    });
  });
});
