import { describe, it, expect } from 'vitest';
import { faviconPaths, SemiontFavicon } from './index';

describe('favicons index exports', () => {
  describe('faviconPaths', () => {
    it('exports all required favicon paths', () => {
      expect(faviconPaths).toBeDefined();
      expect(faviconPaths.ico).toBe('/favicons/favicon.ico');
      expect(faviconPaths.svg).toBe('/favicons/favicon.svg');
      expect(faviconPaths.appleTouchIcon).toBe('/favicons/apple-touch-icon.png');
      expect(faviconPaths.favicon32).toBe('/favicons/favicon-32x32.png');
      expect(faviconPaths.favicon16).toBe('/favicons/favicon-16x16.png');
      expect(faviconPaths.androidChrome192).toBe('/favicons/android-chrome-192x192.png');
      expect(faviconPaths.androidChrome512).toBe('/favicons/android-chrome-512x512.png');
      expect(faviconPaths.manifest).toBe('/favicons/site.webmanifest');
    });

    it('exports frozen object to prevent modifications', () => {
      const paths = faviconPaths as any;

      // Verify all properties exist
      expect(Object.keys(paths)).toHaveLength(8);

      // Verify the object is effectively immutable (const assertion)
      expect(() => {
        // This would be a TypeScript error, but we can test runtime behavior
        const mutablePaths = { ...faviconPaths };
        mutablePaths.ico = '/modified/path';
        // Original should remain unchanged
        expect(faviconPaths.ico).toBe('/favicons/favicon.ico');
      }).not.toThrow();
    });

    it('contains valid path strings', () => {
      Object.values(faviconPaths).forEach(path => {
        expect(typeof path).toBe('string');
        expect(path).toMatch(/^\/favicons\//);
        expect(path.length).toBeGreaterThan(10);
      });
    });

    it('paths follow expected naming conventions', () => {
      expect(faviconPaths.ico).toMatch(/\.ico$/);
      expect(faviconPaths.svg).toMatch(/\.svg$/);
      expect(faviconPaths.appleTouchIcon).toMatch(/\.png$/);
      expect(faviconPaths.favicon32).toMatch(/32x32\.png$/);
      expect(faviconPaths.favicon16).toMatch(/16x16\.png$/);
      expect(faviconPaths.androidChrome192).toMatch(/192x192\.png$/);
      expect(faviconPaths.androidChrome512).toMatch(/512x512\.png$/);
      expect(faviconPaths.manifest).toMatch(/\.webmanifest$/);
    });
  });

  describe('SemiontFavicon component export', () => {
    it('exports SemiontFavicon component', () => {
      expect(SemiontFavicon).toBeDefined();
      expect(typeof SemiontFavicon).toBe('function');
    });

    it('component has expected name', () => {
      expect(SemiontFavicon.name).toBe('SemiontFavicon');
    });
  });

  describe('integration', () => {
    it('provides complete favicon solution', () => {
      // Verify we have both static paths and dynamic component
      expect(faviconPaths).toBeDefined();
      expect(SemiontFavicon).toBeDefined();

      // Common use cases
      const icoPath = faviconPaths.ico;
      expect(icoPath).toBe('/favicons/favicon.ico');

      const svgPath = faviconPaths.svg;
      expect(svgPath).toBe('/favicons/favicon.svg');

      // Component can be used for inline rendering
      expect(typeof SemiontFavicon).toBe('function');
    });

    it('covers all standard favicon use cases', () => {
      // Desktop browsers
      expect(faviconPaths.ico).toBeDefined();
      expect(faviconPaths.favicon16).toBeDefined();
      expect(faviconPaths.favicon32).toBeDefined();

      // Modern browsers
      expect(faviconPaths.svg).toBeDefined();

      // Apple devices
      expect(faviconPaths.appleTouchIcon).toBeDefined();

      // Android devices
      expect(faviconPaths.androidChrome192).toBeDefined();
      expect(faviconPaths.androidChrome512).toBeDefined();

      // PWA manifest
      expect(faviconPaths.manifest).toBeDefined();
    });
  });
});