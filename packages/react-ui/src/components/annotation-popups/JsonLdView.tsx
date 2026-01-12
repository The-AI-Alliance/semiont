'use client';

import React, { useEffect, useRef } from 'react';
import { EditorView, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { syntaxHighlighting } from '@codemirror/language';
import { jsonLightTheme, jsonLightHighlightStyle } from '../../lib/codemirror-json-theme';
import { useLineNumbers } from '../../hooks/useLineNumbers';
import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

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
    <div className="semiont-jsonld-view">
      {/* Header with back and copy buttons */}
      <div className="semiont-jsonld-view__header">
        <button
          onClick={onBack}
          className="semiont-jsonld-view__back-button"
          title="Go back (Escape)"
        >
          &lt;
        </button>
        <h3 className="semiont-jsonld-view__title">
          JSON-LD
        </h3>
        <button
          onClick={handleCopyToClipboard}
          className="semiont-jsonld-view__copy-button"
          title="Copy to clipboard"
        >
          📋 Copy
        </button>
      </div>

      {/* JSON-LD content rendered with CodeMirror */}
      <div
        ref={editorRef}
        className="semiont-jsonld-view__editor"
      />
    </div>
  );
}
