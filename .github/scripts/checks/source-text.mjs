/**
 * Source text with its comments blanked, for lints that look for a use of
 * something rather than a mention of it. Rust and TypeScript alike: a line
 * comment runs from `//` preceded by nothing or whitespace — never a URL's
 * `://`; a block comment from `/*` preceded by nothing or whitespace — never
 * a glob's `**\/*` — to the next `*\/`. Blanked, not removed, so line numbers
 * hold.
 */
export function withoutComments(text) {
  const blocks = text.replace(/(^|\s)\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  return blocks.split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}
