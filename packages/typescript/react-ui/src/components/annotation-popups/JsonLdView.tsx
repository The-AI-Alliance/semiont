'use client';

import { useEffect, useRef } from 'react';
import { EditorView, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { syntaxHighlighting } from '@codemirror/language';
import { clipboard } from '../../lib/clipboard';
import { jsonTheme, jsonHighlightStyle } from '../../lib/codemirror-json-theme';

import type { Annotation } from '@semiont/core';

interface JsonLdViewProps {
  annotation: Annotation;
  onBack: () => void;
  /** Whether the editor numbers its lines: the viewer's own setting, handed down. */
  showLineNumbers: boolean;
}

/**
 * An annotation as W3C Web Annotation JSON-LD, read-only. It reads no
 * provider: its line numbers come from the viewer that opens it, and its
 * colours from the page's theme, through the CSS variables the JSON theme is
 * written in.
 */
export function JsonLdView({ annotation, onBack, showLineNumbers }: JsonLdViewProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Store callback in ref to avoid including in dependency arrays
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onBackRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Initialize CodeMirror
  useEffect(() => {
    if (!editorRef.current) return;

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

    // One theme for light and dark: its colours are CSS variables the page's theme sets.
    extensions.push(jsonTheme);
    extensions.push(syntaxHighlighting(jsonHighlightStyle));

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

  const copyTo = clipboard();
  const handleCopyToClipboard = async (to: Clipboard) => {
    try {
      await to.writeText(JSON.stringify(annotation, null, 2));
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
        {copyTo && (
          <button
            onClick={() => handleCopyToClipboard(copyTo)}
            className="semiont-jsonld-view__copy-button"
            title="Copy to clipboard"
          >
            📋 Copy
          </button>
        )}
      </div>

      {/* JSON-LD content rendered with CodeMirror */}
      <div
        ref={editorRef}
        className="semiont-jsonld-view__editor"
      />
    </div>
  );
}
