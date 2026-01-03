/**
 * Shared CodeMirror JSON theme for light mode
 * Used by both JsonLdView (popups) and JsonLdPanel (sidebar)
 */

import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// Colorful light theme for JSON with vibrant syntax highlighting
export const jsonLightTheme = EditorView.theme({
  '&': {
    backgroundColor: '#ffffff',
    color: '#24292e',
  },
  '.cm-content': {
    caretColor: '#0550ae',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#0550ae',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: '#b3d7ff',
  },
  '.cm-gutters': {
    backgroundColor: '#f6f8fa',
    color: '#57606a',
    border: 'none',
  },
}, { dark: false });

export const jsonLightHighlightStyle = HighlightStyle.define([
  { tag: t.string, color: '#0a3069' },        // Deep blue for strings
  { tag: t.number, color: '#0550ae' },        // Bright blue for numbers
  { tag: t.bool, color: '#8250df' },          // Purple for booleans
  { tag: t.null, color: '#cf222e' },          // Red for null
  { tag: t.keyword, color: '#cf222e' },       // Red for keywords
  { tag: t.propertyName, color: '#116329' },  // Green for property names
  { tag: t.punctuation, color: '#57606a' },   // Gray for punctuation
  { tag: t.bracket, color: '#6e7781' },       // Darker gray for brackets
]);
