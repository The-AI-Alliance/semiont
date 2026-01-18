'use client';

import React, { useEffect, useRef } from 'react';
import { EditorView, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { syntaxHighlighting } from '@codemirror/language';
import { jsonLightTheme, jsonLightHighlightStyle } from '../../../lib/codemirror-json-theme';
import { useLineNumbers } from '../../../hooks/useLineNumbers';
import type { components } from '@semiont/api-client';

type SemiontResource = components['schemas']['ResourceDescriptor'];

interface Props {
  resource: SemiontResource;
}

export function JsonLdPanel({ resource: semiontResource }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { showLineNumbers } = useLineNumbers();

  // Initialize CodeMirror
  useEffect(() => {
    if (!editorRef.current) return;

    // Check if dark mode is active
    const isDarkMode = document.documentElement?.classList.contains('dark') ?? false;

    // Convert resource to JSON-LD format
    const jsonLdContent = JSON.stringify(semiontResource, null, 2);

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
      doc: jsonLdContent,
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
  }, [semiontResource, showLineNumbers]);

  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(semiontResource, null, 2));
    } catch (err) {
      console.error('Failed to copy JSON-LD:', err);
    }
  };

  return (
    <div className="semiont-jsonld-panel">
      {/* Header with copy button */}
      <div className="semiont-jsonld-panel__header">
        <h3 className="semiont-jsonld-panel__title">
          JSON-LD
        </h3>
        <button
          onClick={handleCopyToClipboard}
          className="semiont-button semiont-button--icon"
          title="Copy to clipboard"
        >
          📋 Copy
        </button>
      </div>

      {/* JSON-LD content rendered with CodeMirror */}
      <div
        ref={editorRef}
        className="semiont-jsonld-panel__editor"
      />
    </div>
  );
}
