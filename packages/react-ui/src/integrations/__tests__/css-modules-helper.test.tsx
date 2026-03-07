import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import {
  createSemiontClassName,
  generateDataAttributes,
  mergeDataAttributes,
  withCSSModules,
  cssModulesConfig,
  defineCSSModules,
} from '../css-modules-helper';

describe('css-modules-helper', () => {
  describe('createSemiontClassName', () => {
    it('returns base class when no module match', () => {
      const build = createSemiontClassName({}, 'semiont-button');
      expect(build({})).toBe('semiont-button');
    });

    it('adds CSS module class when available', () => {
      const styles = { 'semiont-button': 'abc123' };
      const build = createSemiontClassName(styles, 'semiont-button');
      const result = build({});
      expect(result).toContain('semiont-button');
      expect(result).toContain('abc123');
    });

    it('appends additional classes', () => {
      const build = createSemiontClassName({}, 'semiont-button');
      const result = build({}, 'extra-class');
      expect(result).toContain('semiont-button');
      expect(result).toContain('extra-class');
    });
  });

  describe('generateDataAttributes', () => {
    it('generates data attributes from props', () => {
      const attrs = generateDataAttributes({
        variant: 'primary',
        size: 'md',
        loading: true,
        fullWidth: true,
        iconOnly: true,
        active: true,
        disabled: true,
        orientation: 'horizontal',
        attached: true,
        spacing: 'md',
      });

      expect(attrs['data-variant']).toBe('primary');
      expect(attrs['data-size']).toBe('md');
      expect(attrs['data-loading']).toBe('true');
      expect(attrs['data-full-width']).toBe('true');
      expect(attrs['data-icon-only']).toBe('true');
      expect(attrs['data-active']).toBe('true');
      expect(attrs['data-disabled']).toBe('true');
      expect(attrs['data-orientation']).toBe('horizontal');
      expect(attrs['data-attached']).toBe('true');
    });

    it('omits undefined values for falsy booleans', () => {
      const attrs = generateDataAttributes({
        loading: false,
        fullWidth: false,
        iconOnly: false,
        active: false,
        disabled: false,
        attached: false,
      });

      expect(attrs['data-loading']).toBeUndefined();
      expect(attrs['data-full-width']).toBeUndefined();
      expect(attrs['data-icon-only']).toBeUndefined();
      expect(attrs['data-active']).toBeUndefined();
      expect(attrs['data-disabled']).toBeUndefined();
      expect(attrs['data-attached']).toBeUndefined();
    });

    it('omits spacing when attached is true', () => {
      const attrs = generateDataAttributes({
        attached: true,
        spacing: 'lg',
      });
      expect(attrs['data-spacing']).toBeUndefined();
    });

    it('includes spacing when attached is false', () => {
      const attrs = generateDataAttributes({
        attached: false,
        spacing: 'lg',
      });
      expect(attrs['data-spacing']).toBe('lg');
    });
  });

  describe('mergeDataAttributes', () => {
    it('merges data attributes into props', () => {
      const props = { id: 'btn', className: 'foo' };
      const dataAttrs = { 'data-variant': 'primary', 'data-size': 'md' };
      const merged = mergeDataAttributes(props, dataAttrs);

      expect(merged.id).toBe('btn');
      expect(merged.className).toBe('foo');
      expect(merged['data-variant']).toBe('primary');
      expect(merged['data-size']).toBe('md');
    });

    it('skips undefined data attributes', () => {
      const props = { id: 'btn' };
      const dataAttrs = { 'data-variant': 'primary', 'data-size': undefined };
      const merged = mergeDataAttributes(props, dataAttrs);

      expect(merged['data-variant']).toBe('primary');
      expect(merged).not.toHaveProperty('data-size');
    });

    it('does not mutate original props', () => {
      const props = { id: 'btn' };
      mergeDataAttributes(props, { 'data-x': 'y' });
      expect(props).not.toHaveProperty('data-x');
    });
  });

  describe('withCSSModules', () => {
    it('wraps a component with CSS module classes', () => {
      const Inner = (props: { className?: string }) => (
        <span data-testid="inner" className={props.className} />
      );
      const styles = { button: 'hashed_button' };
      const Wrapped = withCSSModules(Inner, styles, 'button');

      const { getByTestId } = render(<Wrapped />);
      const el = getByTestId('inner');
      expect(el.className).toContain('button');
      expect(el.className).toContain('hashed_button');
    });

    it('preserves existing className from props', () => {
      const Inner = (props: { className?: string }) => (
        <span data-testid="inner" className={props.className} />
      );
      const styles = { button: 'hashed' };
      const Wrapped = withCSSModules(Inner, styles, 'button');

      const { getByTestId } = render(<Wrapped className="custom" />);
      const el = getByTestId('inner');
      expect(el.className).toContain('custom');
      expect(el.className).toContain('hashed');
    });

    it('passes through other props', () => {
      const Inner = (props: { className?: string; 'data-testid'?: string; title?: string }) => (
        <span data-testid={props['data-testid']} title={props.title} />
      );
      const Wrapped = withCSSModules(Inner, {}, 'btn');

      const { getByTestId } = render(<Wrapped data-testid="test" title="hello" />);
      expect(getByTestId('test')).toHaveAttribute('title', 'hello');
    });
  });

  describe('cssModulesConfig', () => {
    it('has postcss config', () => {
      expect(cssModulesConfig.postcss).toBeDefined();
      expect(cssModulesConfig.postcss.plugins).toHaveLength(1);
      expect(cssModulesConfig.postcss.plugins[0].postcssPlugin).toBe('preserve-data-attributes');
    });

    it('has webpack config with getLocalIdent', () => {
      expect(cssModulesConfig.webpack.cssLoader.modules.localIdentName).toBeDefined();
      const getLocalIdent = cssModulesConfig.webpack.cssLoader.modules.getLocalIdent;
      expect(typeof getLocalIdent).toBe('function');

      // semiont- prefixed classes are preserved
      expect(getLocalIdent(null, '', 'semiont-button')).toBe('semiont-button');
      // other classes return null for default hashing
      expect(getLocalIdent(null, '', 'my-class')).toBeNull();
    });

    it('has vite config', () => {
      expect(cssModulesConfig.vite.css.modules.scopeBehaviour).toBe('local');
      expect(cssModulesConfig.vite.css.modules.generateScopedName).toBeDefined();
    });

    describe('postcss plugin', () => {
      it('wraps class selectors in :global when rule contains [data-', () => {
        const plugin = cssModulesConfig.postcss.plugins[0];
        const rules: any[] = [];
        const mockRoot = {
          walkRules: (cb: (rule: any) => void) => {
            for (const rule of rules) cb(rule);
          },
        };

        // Rule with data-attribute selector
        const rule = { selector: '.button[data-variant="primary"]' };
        rules.push(rule);
        plugin.Once(mockRoot);

        expect(rule.selector).toContain(':global(.button)');
      });

      it('does not modify rules without data-attribute selectors', () => {
        const plugin = cssModulesConfig.postcss.plugins[0];
        const rule = { selector: '.button .icon' };
        const mockRoot = {
          walkRules: (cb: (rule: any) => void) => cb(rule),
        };
        plugin.Once(mockRoot);
        expect(rule.selector).toBe('.button .icon');
      });
    });
  });

  describe('defineCSSModules', () => {
    it('returns the styles object typed', () => {
      const raw = { button: 'abc', 'button-content': 'def' };
      const typed = defineCSSModules(raw);
      expect(typed).toBe(raw);
      expect(typed.button).toBe('abc');
      expect(typed['button-content']).toBe('def');
    });
  });
});
