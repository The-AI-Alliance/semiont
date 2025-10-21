'use client';

import React, { useEffect, useRef } from 'react';
import { EditorView, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { useLineNumbers } from '@/hooks/useLineNumbers';
import type { Annotation } from '@/lib/api';

// Colorful light theme for JSON with vibrant syntax highlighting
const jsonLightTheme = EditorView.theme({
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

const jsonLightHighlightStyle = HighlightStyle.define([
  { tag: t.string, color: '#0a3069' },        // Deep blue for strings
  { tag: t.number, color: '#0550ae' },        // Bright blue for numbers
  { tag: t.bool, color: '#8250df' },          // Purple for booleans
  { tag: t.null, color: '#cf222e' },          // Red for null
  { tag: t.keyword, color: '#cf222e' },       // Red for keywords
  { tag: t.propertyName, color: '#116329' },  // Green for property names
  { tag: t.punctuation, color: '#57606a' },   // Gray for punctuation
  { tag: t.bracket, color: '#6e7781' },       // Darker gray for brackets
]);

interface JsonLdViewProps {
  annotation: Annotation;
  onBack: () => void;
}

export function JsonLdView({ annotation, onBack }: JsonLdViewProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { showLineNumbers } = useLineNumbers();

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onBack();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onBack]);

  // Initialize CodeMirror
  useEffect(() => {
    if (!editorRef.current) return;

    // Check if dark mode is active
    const isDarkMode = document.documentElement.classList.contains('dark');

    const jsonContent = JSON.stringify(annotation, null, 2);

    const extensions = [
      json(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
    ];

    // Add line numbers if enabled
    if (showLineNumbers) {
      extensions.push(lineNumbers());
    }

    // Add theme based on dark/light mode
    if (isDarkMode) {
      extensions.push(oneDark);
    } else {
      extensions.push(jsonLightTheme);
      extensions.push(syntaxHighlighting(jsonLightHighlightStyle));
    }

    const state = EditorState.create({
      doc: jsonContent,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [annotation, showLineNumbers]);

  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(annotation, null, 2));
    } catch (err) {
      console.error('Failed to copy JSON-LD:', err);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header with back and copy buttons */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <button
          onClick={onBack}
          className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300 text-lg font-bold"
          title="Go back (Escape)"
        >
          &lt;
        </button>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          JSON-LD
        </h3>
        <button
          onClick={handleCopyToClipboard}
          className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300 text-base"
          title="Copy to clipboard"
        >
          📋
        </button>
      </div>

      {/* JSON-LD content rendered with CodeMirror */}
      <div
        ref={editorRef}
        className="flex-1 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700"
      />
    </div>
  );
}
