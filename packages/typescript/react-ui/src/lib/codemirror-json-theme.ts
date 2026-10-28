/**
 * The CodeMirror theme of the JSON views, `JsonLdView` (popups) and
 * `JsonLdPanel` (sidebar), for light and dark alike.
 *
 * Every colour is a CSS variable of `styles/variables.css`, so the page's
 * `data-theme` attribute picks them, as it picks every other colour, and the
 * views read no theme of their own. The frame takes the page's background,
 * text and gutter colours; the syntax takes the `--semiont-json-*` ones.
 */

import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const jsonTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--semiont-bg-primary)',
    color: 'var(--semiont-text-primary)',
  },
  '.cm-content': {
    caretColor: 'var(--semiont-text-primary)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--semiont-text-primary)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--semiont-bg-tertiary)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--semiont-bg-secondary)',
    color: 'var(--semiont-text-tertiary)',
    border: 'none',
  },
});

export const jsonHighlightStyle = HighlightStyle.define([
  { tag: t.string, color: 'var(--semiont-json-string)' },
  { tag: t.number, color: 'var(--semiont-json-number)' },
  { tag: [t.bool, t.null, t.keyword], color: 'var(--semiont-json-literal)' },
  { tag: t.propertyName, color: 'var(--semiont-json-property)' },
  { tag: [t.punctuation, t.bracket], color: 'var(--semiont-json-punctuation)' },
]);
