'use client';

import { useEffect, useRef } from 'react';
import { EditorView, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { syntaxHighlighting } from '@codemirror/language';
import { clipboard } from '../../../lib/clipboard';
import { jsonLightTheme, jsonLightHighlightStyle } from '../../../lib/codemirror-json-theme';
import { useLineNumbers } from '../../../contexts/LineNumbersContext';
import { useTheme } from '../../../contexts/ThemeContext';
import { useResourceGraph } from '../../../hooks/useResourceGraph';
import type { ResourceId } from '@semiont/core';
import './JsonLdPanel.css';

interface Props {
  resourceId: ResourceId;
}

/**
 * Dereferences the resource's LD face (`GET /resources/:id/jsonld` via
 * `browse.resourceGraph`) and pretty-prints the full graph — descriptor +
 * annotations + inbound entity references — read-only. This is exactly what
 * an external linked-data client gets when dereferencing the resource's
 * `describedby` URI, so the panel doubles as a living end-to-end test of the
 * LD face.
 */
export function JsonLdPanel({ resourceId }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { showLineNumbers } = useLineNumbers();
  const { resolvedTheme } = useTheme();
  const { graph, loading, error } = useResourceGraph(resourceId);

  const documentText = graph ? JSON.stringify(graph, null, 2) : '';

  // Initialize CodeMirror once the graph has loaded.
  useEffect(() => {
    if (!editorRef.current || !documentText) return;

    const extensions = [
      json(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
    ];

    if (showLineNumbers) {
      extensions.push(lineNumbers());
    }

    if (resolvedTheme === 'dark') {
      extensions.push(oneDark);
    } else {
      extensions.push(jsonLightTheme);
      extensions.push(syntaxHighlighting(jsonLightHighlightStyle));
    }

    const state = EditorState.create({
      doc: documentText,
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
  }, [documentText, showLineNumbers, resolvedTheme]);

  const copyTo = clipboard();
  const handleCopyToClipboard = async (to: Clipboard) => {
    if (!documentText) return;
    try {
      await to.writeText(documentText);
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
        {copyTo && (
          <button
            onClick={() => handleCopyToClipboard(copyTo)}
            className="semiont-button semiont-button-icon"
            title="Copy to clipboard"
            disabled={!graph}
          >
            📋 Copy
          </button>
        )}
      </div>

      {loading && (
        <p className="semiont-jsonld-panel__status" role="status">
          Loading JSON-LD…
        </p>
      )}
      {error && !loading && (
        <p className="semiont-jsonld-panel__status semiont-jsonld-panel__status--error" role="alert">
          Failed to load JSON-LD.
        </p>
      )}

      {/* JSON-LD content rendered with CodeMirror */}
      <div
        ref={editorRef}
        className="semiont-jsonld-panel__editor"
      />
    </div>
  );
}
