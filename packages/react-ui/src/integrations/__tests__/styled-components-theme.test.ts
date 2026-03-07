import { describe, it, expect } from 'vitest';
import { semiontTheme, semiontMixins, createStyledSemiontButton } from '../styled-components-theme';
import { tokens } from '../../design-tokens';

describe('styled-components-theme', () => {
  describe('semiontTheme', () => {
    it('includes all token categories', () => {
      expect(semiontTheme).toHaveProperty('colors');
      expect(semiontTheme).toHaveProperty('spacing');
      expect(semiontTheme).toHaveProperty('typography');
      expect(semiontTheme).toHaveProperty('borderRadius');
      expect(semiontTheme).toHaveProperty('shadows');
      expect(semiontTheme).toHaveProperty('transitions');
      expect(semiontTheme).toHaveProperty('breakpoints');
    });

    it('spacing matches tokens.spacing', () => {
      expect(semiontTheme.spacing).toBe(tokens.spacing);
    });

    it('typography matches tokens.typography', () => {
      expect(semiontTheme.typography).toBe(tokens.typography);
    });

    it('borderRadius matches tokens.borderRadius', () => {
      expect(semiontTheme.borderRadius).toBe(tokens.borderRadius);
    });

    it('shadows matches tokens.shadows', () => {
      expect(semiontTheme.shadows).toBe(tokens.shadows);
    });

    it('transitions matches tokens.transitions', () => {
      expect(semiontTheme.transitions).toBe(tokens.transitions);
    });

    it('breakpoints matches tokens.breakpoints', () => {
      expect(semiontTheme.breakpoints).toBe(tokens.breakpoints);
    });

    it('flattens semantic colors onto colors', () => {
      expect(semiontTheme.colors.error).toBe(tokens.colors.semantic.error);
      expect(semiontTheme.colors.errorLight).toBe(tokens.colors.semantic.errorLight);
      expect(semiontTheme.colors.errorDark).toBe(tokens.colors.semantic.errorDark);
      expect(semiontTheme.colors.warning).toBe(tokens.colors.semantic.warning);
      expect(semiontTheme.colors.warningLight).toBe(tokens.colors.semantic.warningLight);
      expect(semiontTheme.colors.warningDark).toBe(tokens.colors.semantic.warningDark);
      expect(semiontTheme.colors.success).toBe(tokens.colors.semantic.success);
      expect(semiontTheme.colors.successLight).toBe(tokens.colors.semantic.successLight);
      expect(semiontTheme.colors.successDark).toBe(tokens.colors.semantic.successDark);
      expect(semiontTheme.colors.info).toBe(tokens.colors.semantic.info);
      expect(semiontTheme.colors.infoLight).toBe(tokens.colors.semantic.infoLight);
      expect(semiontTheme.colors.infoDark).toBe(tokens.colors.semantic.infoDark);
    });

    it('preserves nested color structures', () => {
      expect(semiontTheme.colors.primary).toBe(tokens.colors.primary);
      expect(semiontTheme.colors.secondary).toBe(tokens.colors.secondary);
      expect(semiontTheme.colors.neutral).toBe(tokens.colors.neutral);
      expect(semiontTheme.colors.semantic).toBe(tokens.colors.semantic);
    });
  });

  describe('semiontMixins', () => {
    it('has buttonBase mixin', () => {
      expect(semiontMixins.buttonBase).toBeDefined();
    });

    it('has buttonVariant function', () => {
      expect(typeof semiontMixins.buttonVariant).toBe('function');
    });

    it('buttonVariant accepts variant strings', () => {
      for (const variant of ['primary', 'secondary', 'tertiary', 'danger', 'warning', 'ghost']) {
        expect(semiontMixins.buttonVariant(variant)).toBeDefined();
      }
    });

    it('has buttonSize function', () => {
      expect(typeof semiontMixins.buttonSize).toBe('function');
    });

    it('buttonSize accepts size strings', () => {
      for (const size of ['xs', 'sm', 'md', 'lg', 'xl']) {
        expect(semiontMixins.buttonSize(size)).toBeDefined();
      }
    });

    it('has focusRing function', () => {
      expect(typeof semiontMixins.focusRing).toBe('function');
      expect(semiontMixins.focusRing()).toBeDefined();
      expect(semiontMixins.focusRing('#ff0000')).toBeDefined();
    });

    it('has truncate mixin', () => {
      expect(semiontMixins.truncate).toBeDefined();
    });

    it('has srOnly mixin', () => {
      expect(semiontMixins.srOnly).toBeDefined();
    });

    it('has media query helpers', () => {
      expect(semiontMixins.media).toHaveProperty('sm');
      expect(semiontMixins.media).toHaveProperty('md');
      expect(semiontMixins.media).toHaveProperty('lg');
      expect(semiontMixins.media).toHaveProperty('xl');
      expect(semiontMixins.media).toHaveProperty('2xl');
    });

    it('media helpers are functions', () => {
      expect(typeof semiontMixins.media.sm).toBe('function');
      expect(typeof semiontMixins.media.md).toBe('function');
      expect(typeof semiontMixins.media.lg).toBe('function');
    });
  });

  describe('createStyledSemiontButton', () => {
    it('is a function', () => {
      expect(typeof createStyledSemiontButton).toBe('function');
    });

    it('calls styled.button.attrs', () => {
      let attrsArg: any;
      let templateArg: any;

      const mockStyled = {
        button: {
          attrs: (arg: any) => {
            attrsArg = arg;
            return (strings: TemplateStringsArray, ...exprs: any[]) => {
              templateArg = { strings, exprs };
              return 'MockComponent';
            };
          },
        },
      };

      const result = createStyledSemiontButton(mockStyled);
      expect(result).toBe('MockComponent');
      expect(attrsArg).toBeDefined();

      // Test the attrs function generates correct data attributes
      const attrs = attrsArg({
        variant: 'primary',
        size: 'md',
        loading: true,
        fullWidth: true,
        iconOnly: false,
        active: true,
        disabled: false,
        className: 'custom',
      });

      expect(attrs['data-variant']).toBe('primary');
      expect(attrs['data-size']).toBe('md');
      expect(attrs['data-loading']).toBe('true');
      expect(attrs['data-full-width']).toBe('true');
      expect(attrs['data-icon-only']).toBeUndefined();
      expect(attrs['data-active']).toBe('true');
      expect(attrs['data-disabled']).toBeUndefined();
      expect(attrs.className).toBe('semiont-button custom');
    });

    it('attrs trims className when no additional class', () => {
      const mockStyled = {
        button: {
          attrs: (arg: any) => {
            const attrs = arg({});
            expect(attrs.className).toBe('semiont-button');
            return () => 'MockComponent';
          },
        },
      };

      createStyledSemiontButton(mockStyled);
    });
  });
});
