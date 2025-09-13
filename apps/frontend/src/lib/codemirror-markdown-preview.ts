/**
 * Custom CodeMirror 6 Extension for Markdown Preview
 * 
 * This extension transforms markdown syntax into formatted display
 * while maintaining source positions for accurate annotation mapping.
 */

import { 
  EditorView, 
  Decoration, 
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view';
import { RangeSetBuilder, StateField, StateEffect } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Tree } from '@lezer/common';

/**
 * APPROACH 1: Decoration-Based Formatting
 * 
 * This approach uses CodeMirror's decoration system to:
 * 1. Hide markdown syntax characters
 * 2. Apply CSS classes for formatting
 * 3. Maintain original positions
 */

// Define decoration types for different markdown elements
const hideDecoration = Decoration.replace({}); // Hides syntax characters
const headerDecoration = (level: number) => 
  Decoration.mark({ 
    class: `md-header-${level}`,
    attributes: { 'data-header-level': String(level) }
  });
const boldDecoration = Decoration.mark({ class: 'md-bold' });
const italicDecoration = Decoration.mark({ class: 'md-italic' });
const linkDecoration = Decoration.mark({ class: 'md-link' });
const codeDecoration = Decoration.mark({ class: 'md-code' });
const listItemDecoration = Decoration.mark({ class: 'md-list-item' });

/**
 * APPROACH 2: Widget Replacement
 * 
 * For more complex transformations, we can replace entire ranges with widgets
 */

class HeaderWidget extends WidgetType {
  constructor(readonly level: number, readonly text: string) {
    super();
  }

  toDOM() {
    const element = document.createElement(`h${this.level}`);
    element.textContent = this.text;
    element.className = `md-header-widget md-h${this.level}`;
    return element;
  }
  
  get estimatedHeight() {
    // Estimate height based on header level for virtual scrolling
    return [48, 40, 36, 32, 28, 24][this.level - 1] || 24;
  }
}

class ListBulletWidget extends WidgetType {
  toDOM() {
    const bullet = document.createElement('span');
    bullet.className = 'md-list-bullet';
    bullet.textContent = '• ';
    return bullet;
  }
}

/**
 * Main markdown preview plugin
 */
export const markdownPreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const tree = syntaxTree(view.state);
      
      // Walk through the syntax tree
      tree.iterate({
        enter: (node) => {
          const from = node.from;
          const to = node.to;
          const text = view.state.doc.sliceString(from, to);
          
          switch (node.name) {
            // Headers: # Title -> formatted title
            case 'ATXHeading1':
            case 'ATXHeading2':
            case 'ATXHeading3':
            case 'ATXHeading4':
            case 'ATXHeading5':
            case 'ATXHeading6': {
              const level = parseInt(node.name.slice(-1));
              const hashEnd = text.indexOf(' ') + 1 || text.length;
              
              // Hide the # characters
              builder.add(from, from + hashEnd, hideDecoration);
              
              // Apply header styling to the text
              builder.add(from + hashEnd, to, headerDecoration(level));
              break;
            }
            
            // Bold: **text** -> bold text
            case 'StrongEmphasis': {
              const markLen = 2; // ** or __
              
              // Hide opening **
              builder.add(from, from + markLen, hideDecoration);
              
              // Apply bold to content
              builder.add(from + markLen, to - markLen, boldDecoration);
              
              // Hide closing **
              builder.add(to - markLen, to, hideDecoration);
              break;
            }
            
            // Italic: *text* -> italic text
            case 'Emphasis': {
              const markLen = 1; // * or _
              
              // Hide opening *
              builder.add(from, from + markLen, hideDecoration);
              
              // Apply italic to content
              builder.add(from + markLen, to - markLen, italicDecoration);
              
              // Hide closing *
              builder.add(to - markLen, to, hideDecoration);
              break;
            }
            
            // Lists: - item -> • item
            case 'ListItem': {
              const bulletMatch = text.match(/^[-*+]\s+/);
              if (bulletMatch) {
                // Replace - with bullet widget
                builder.add(
                  from, 
                  from + bulletMatch[0].length,
                  Decoration.replace({ widget: new ListBulletWidget() })
                );
              }
              break;
            }
            
            // Inline code: `code` -> styled code
            case 'InlineCode': {
              // Hide opening `
              builder.add(from, from + 1, hideDecoration);
              
              // Apply code styling
              builder.add(from + 1, to - 1, codeDecoration);
              
              // Hide closing `
              builder.add(to - 1, to, hideDecoration);
              break;
            }
            
            // Links: [text](url) -> styled link
            case 'Link': {
              // This is more complex - would need to parse link structure
              // For now, just style the whole thing
              builder.add(from, to, linkDecoration);
              break;
            }
          }
        }
      });
      
      return builder.finish();
    }
  },
  {
    decorations: v => v.decorations
  }
);

/**
 * CSS styles to accompany the extension
 * These would go in globals.css or a separate stylesheet
 */
export const markdownPreviewStyles = `
  /* Headers */
  .md-header-1 { font-size: 2em; font-weight: bold; line-height: 1.2; }
  .md-header-2 { font-size: 1.5em; font-weight: bold; line-height: 1.3; }
  .md-header-3 { font-size: 1.25em; font-weight: bold; line-height: 1.4; }
  .md-header-4 { font-size: 1.1em; font-weight: bold; }
  .md-header-5 { font-size: 1em; font-weight: bold; }
  .md-header-6 { font-size: 0.9em; font-weight: bold; }
  
  /* Text formatting */
  .md-bold { font-weight: bold; }
  .md-italic { font-style: italic; }
  .md-code { 
    background: rgba(0, 0, 0, 0.05);
    padding: 2px 4px;
    border-radius: 3px;
    font-family: monospace;
    font-size: 0.9em;
  }
  
  /* Links */
  .md-link { 
    color: #0969da;
    text-decoration: underline;
    cursor: pointer;
  }
  
  /* Lists */
  .md-list-bullet {
    color: #666;
    font-weight: bold;
  }
  .md-list-item {
    padding-left: 1em;
  }
  
  /* Header widgets (if using widget approach) */
  .md-header-widget {
    display: block;
    margin: 0.5em 0;
  }
  .md-h1 { font-size: 2em; font-weight: bold; }
  .md-h2 { font-size: 1.5em; font-weight: bold; }
  .md-h3 { font-size: 1.25em; font-weight: bold; }
`;

/**
 * State field to track markdown preview mode
 */
export const markdownPreviewState = StateField.define<boolean>({
  create: () => true, // Preview mode on by default
  update: (value, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(togglePreviewEffect)) {
        return !value;
      }
    }
    return value;
  }
});

// Effect to toggle preview mode
export const togglePreviewEffect = StateEffect.define<void>();

/**
 * Complete extension bundle
 */
export function markdownPreview() {
  return [
    markdownPreviewPlugin,
    markdownPreviewState,
    EditorView.theme({
      '.cm-editor': {
        fontSize: '16px',
        lineHeight: '1.6'
      }
    })
  ];
}

/**
 * APPROACH 3: Hybrid Solution
 * 
 * For complex cases like tables or math, we could:
 * 1. Use decorations for simple formatting
 * 2. Use widgets for complex elements
 * 3. Maintain a position map for annotations
 */

export interface PositionMap {
  sourceToDisplay: Map<number, number>;
  displayToSource: Map<number, number>;
}

export function buildPositionMap(view: EditorView): PositionMap {
  const map: PositionMap = {
    sourceToDisplay: new Map(),
    displayToSource: new Map()
  };
  
  let sourcePos = 0;
  let displayPos = 0;
  
  const tree = syntaxTree(view.state);
  const doc = view.state.doc;
  
  // Walk through document character by character
  // Track which characters are hidden/replaced
  tree.iterate({
    enter: (node) => {
      const text = doc.sliceString(node.from, node.to);
      
      switch (node.name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3': {
          // # or ## or ### are hidden
          const hashCount = parseInt(node.name.slice(-1));
          const prefixLen = hashCount + 1; // Include space
          
          // Map positions
          for (let i = 0; i < text.length; i++) {
            if (i < prefixLen) {
              // Hidden characters - source advances but display doesn't
              map.sourceToDisplay.set(node.from + i, displayPos);
            } else {
              // Visible characters - both advance
              map.sourceToDisplay.set(node.from + i, displayPos);
              map.displayToSource.set(displayPos, node.from + i);
              displayPos++;
            }
          }
          break;
        }
        
        // Add cases for other markdown elements...
      }
    }
  });
  
  return map;
}

/**
 * Usage in CodeMirrorRenderer.tsx:
 * 
 * import { markdownPreview } from '@/lib/codemirror-markdown-preview';
 * 
 * const state = EditorState.create({
 *   doc: content,
 *   extensions: [
 *     markdown(),           // Parse markdown syntax
 *     markdownPreview(),    // Our custom preview extension
 *     EditorView.editable.of(false),
 *     // ... other extensions
 *   ]
 * });
 */