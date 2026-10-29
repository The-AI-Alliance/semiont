/**
 * Tailwind's `dark:` variant and react-ui's `ThemeProvider` agree on what dark
 * is. `ThemeProvider` marks the theme on `<html>`; a `dark:` class takes effect
 * only if the selector Tailwind compiles it to matches under that mark. When
 * the two name different marks nothing fails — every `dark:` class in the
 * Browser simply never applies.
 *
 * Compiles the stylesheet the Browser ships (`src/app/globals.css`, through
 * the same PostCSS plugin Vite runs) and holds each `dark:` rule's selector
 * against an element rendered under each theme.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@semiont/react-ui';

const STYLESHEET = resolve(process.cwd(), 'src/app/globals.css');

/** `.dark\:bg-blue-900\/30:where(…)` → `dark:bg-blue-900/30` */
function classOf(selector: string): string {
  const escaped = selector.match(/^\.((?:\\.|[^\\:])+)/);
  if (!escaped) throw new Error(`not a class rule: ${selector}`);
  return escaped[1]!.replace(/\\(.)/g, '$1');
}

function renderUnder(theme: 'light' | 'dark', classNames: string[]): HTMLElement {
  localStorage.setItem('theme', theme);
  render(
    <ThemeProvider>
      <p data-testid="probe" className={classNames.join(' ')} />
    </ThemeProvider>,
  );
  return screen.getByTestId('probe');
}

describe("Tailwind's dark: variant", () => {
  let darkSelectors: string[];

  beforeAll(async () => {
    const compiled = await postcss([tailwindcss()]).process(readFileSync(STYLESHEET, 'utf8'), {
      from: STYLESHEET,
    });
    darkSelectors = [];
    compiled.root.walkRules((rule) => {
      if (rule.selector.startsWith('.dark\\:')) darkSelectors.push(rule.selector);
    });
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it('is compiled into the stylesheet for the dark: classes the Browser uses', () => {
    expect(darkSelectors.map(classOf)).toContain('dark:bg-gray-900');
  });

  it("applies under ThemeProvider's dark theme", () => {
    const probe = renderUnder('dark', darkSelectors.map(classOf));

    expect(darkSelectors.filter((selector) => !probe.matches(selector))).toEqual([]);
  });

  it("does not apply under ThemeProvider's light theme", () => {
    const probe = renderUnder('light', darkSelectors.map(classOf));

    expect(darkSelectors.filter((selector) => probe.matches(selector))).toEqual([]);
  });
});
