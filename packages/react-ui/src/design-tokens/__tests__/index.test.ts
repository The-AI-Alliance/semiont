import { describe, it, expect } from 'vitest';
import {
  tokens,
  generateCSSVariables,
  cssVariables,
} from '../index';

describe('design tokens', () => {
  describe('tokens structure', () => {
    it('has all top-level categories', () => {
      expect(tokens).toHaveProperty('colors');
      expect(tokens).toHaveProperty('spacing');
      expect(tokens).toHaveProperty('typography');
      expect(tokens).toHaveProperty('borderRadius');
      expect(tokens).toHaveProperty('shadows');
      expect(tokens).toHaveProperty('transitions');
      expect(tokens).toHaveProperty('breakpoints');
    });

    it('has primary color scale from 50 to 900', () => {
      const keys = Object.keys(tokens.colors.primary);
      expect(keys).toEqual(
        expect.arrayContaining(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'])
      );
    });

    it('has secondary color scale from 50 to 900', () => {
      const keys = Object.keys(tokens.colors.secondary);
      expect(keys).toEqual(
        expect.arrayContaining(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'])
      );
    });

    it('has semantic colors', () => {
      expect(tokens.colors.semantic).toHaveProperty('error');
      expect(tokens.colors.semantic).toHaveProperty('warning');
      expect(tokens.colors.semantic).toHaveProperty('success');
      expect(tokens.colors.semantic).toHaveProperty('info');
    });

    it('has neutral color scale', () => {
      expect(Object.keys(tokens.colors.neutral).length).toBeGreaterThanOrEqual(10);
    });

    it('has background and text colors', () => {
      expect(tokens.colors.background).toHaveProperty('primary');
      expect(tokens.colors.background).toHaveProperty('secondary');
      expect(tokens.colors.text).toHaveProperty('primary');
      expect(tokens.colors.text).toHaveProperty('disabled');
    });

    it('has spacing tokens', () => {
      expect(tokens.spacing).toHaveProperty('xs');
      expect(tokens.spacing).toHaveProperty('sm');
      expect(tokens.spacing).toHaveProperty('md');
      expect(tokens.spacing).toHaveProperty('lg');
      expect(tokens.spacing).toHaveProperty('xl');
    });

    it('has typography tokens', () => {
      expect(tokens.typography.fontFamily).toHaveProperty('sans');
      expect(tokens.typography.fontFamily).toHaveProperty('mono');
      expect(tokens.typography.fontSize).toHaveProperty('base');
      expect(tokens.typography.fontWeight).toHaveProperty('normal');
      expect(tokens.typography.fontWeight).toHaveProperty('bold');
      expect(tokens.typography.lineHeight).toHaveProperty('normal');
    });

    it('has border radius tokens', () => {
      expect(tokens.borderRadius).toHaveProperty('none');
      expect(tokens.borderRadius).toHaveProperty('full');
      expect(tokens.borderRadius.none).toBe('0');
      expect(tokens.borderRadius.full).toBe('9999px');
    });

    it('has shadow tokens', () => {
      expect(tokens.shadows).toHaveProperty('none');
      expect(tokens.shadows).toHaveProperty('sm');
      expect(tokens.shadows).toHaveProperty('lg');
      expect(tokens.shadows.none).toBe('none');
    });

    it('has transition tokens', () => {
      expect(tokens.transitions.duration).toHaveProperty('fast');
      expect(tokens.transitions.duration).toHaveProperty('base');
      expect(tokens.transitions.timing).toHaveProperty('ease');
    });

    it('has breakpoint tokens', () => {
      expect(tokens.breakpoints).toHaveProperty('sm');
      expect(tokens.breakpoints).toHaveProperty('md');
      expect(tokens.breakpoints).toHaveProperty('lg');
    });

    it('all color values are valid hex strings', () => {
      const hexPattern = /^#[0-9a-fA-F]{6}$/;

      for (const value of Object.values(tokens.colors.primary)) {
        expect(value).toMatch(hexPattern);
      }
      for (const value of Object.values(tokens.colors.secondary)) {
        expect(value).toMatch(hexPattern);
      }
      for (const value of Object.values(tokens.colors.semantic)) {
        expect(value).toMatch(hexPattern);
      }
      for (const value of Object.values(tokens.colors.neutral)) {
        expect(value).toMatch(hexPattern);
      }
    });
  });

  describe('generateCSSVariables', () => {
    it('returns a string starting with :root', () => {
      const css = generateCSSVariables();
      expect(css).toMatch(/^:root \{/);
      expect(css).toMatch(/\}$/);
    });

    it('includes primary color variables', () => {
      const css = generateCSSVariables();
      expect(css).toContain('--semiont-color-primary-500');
    });

    it('includes secondary color variables', () => {
      const css = generateCSSVariables();
      expect(css).toContain('--semiont-color-secondary-500');
    });

    it('includes semantic color variables', () => {
      const css = generateCSSVariables();
      expect(css).toContain('--semiont-color-error');
    });

    it('includes neutral color variables', () => {
      const css = generateCSSVariables();
      expect(css).toContain('--semiont-color-neutral-500');
    });

    it('includes spacing variables', () => {
      const css = generateCSSVariables();
      expect(css).toContain('--semiont-spacing-md');
    });

    it('includes typography variables', () => {
      const css = generateCSSVariables();
      expect(css).toContain('--semiont-text-base');
      expect(css).toContain('--semiont-font-bold');
      expect(css).toContain('--semiont-font-sans');
      expect(css).toContain('--semiont-font-mono');
    });

    it('includes border radius variables', () => {
      const css = generateCSSVariables();
      expect(css).toContain('--semiont-radius-lg');
    });

    it('includes shadow variables', () => {
      const css = generateCSSVariables();
      expect(css).toContain('--semiont-shadow-sm');
    });

    it('includes transition duration variables', () => {
      const css = generateCSSVariables();
      expect(css).toContain('--semiont-duration-fast');
    });

    it('lowercases camelCase semantic keys', () => {
      const css = generateCSSVariables();
      // Note: the source calls .toLowerCase() before the regex, so camelCase
      // capitals are already gone before the replace — keys become flat lowercase
      expect(css).toContain('--semiont-color-errorlight');
      expect(css).toContain('--semiont-color-warningdark');
    });
  });

  describe('cssVariables', () => {
    it('is a pre-generated string matching generateCSSVariables()', () => {
      expect(cssVariables).toBe(generateCSSVariables());
    });
  });
});
