/**
 * The JSON views' colours are CSS variables, so the page's `data-theme`
 * attribute picks them, as it picks every other colour. `lint:css-variables`
 * reads stylesheets only and never sees a `var()` written in TypeScript, so
 * this holds the theme module's variables to the stylesheet instead: each is
 * set in every block a theme is set in. A variable set in none would leave the
 * editor uncoloured with no error anywhere.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const theme = readFileSync(resolve(process.cwd(), 'src/lib/codemirror-json-theme.ts'), 'utf8');
const variables = readFileSync(resolve(process.cwd(), 'src/styles/variables.css'), 'utf8');

const used = [...new Set([...theme.matchAll(/var\((--semiont-[a-z0-9-]+)\)/g)].map((match) => match[1]!))];

/** The text of the stylesheet's block that `opening` opens, to its closing brace. */
function block(opening: string): string {
  const at = variables.indexOf(opening);
  if (at === -1) throw new Error(`variables.css has no block opened by ${opening}`);
  let depth = 0;
  for (let index = variables.indexOf('{', at); index < variables.length; index++) {
    if (variables[index] === '{') depth++;
    if (variables[index] === '}') {
      depth--;
      if (depth === 0) return variables.slice(at, index + 1);
    }
  }
  throw new Error(`the block opened by ${opening} does not close`);
}

const themeBlocks = [
  ':root {',
  '@media (prefers-color-scheme: dark) {',
  '[data-theme="light"] {',
  '[data-theme="dark"] {',
];

describe('the JSON theme', () => {
  it('writes its colours as CSS variables', () => {
    expect(used.length).toBeGreaterThan(0);
  });

  it.each(themeBlocks)('has every variable it uses set in the %s block', (opening) => {
    const declared = block(opening);
    const missing = used.filter((name) => !declared.includes(`${name}:`));
    expect(missing).toEqual([]);
  });
});
