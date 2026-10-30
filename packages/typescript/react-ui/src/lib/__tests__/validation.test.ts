import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageURLSchema, sanitizeImageURL } from '../validation';

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
