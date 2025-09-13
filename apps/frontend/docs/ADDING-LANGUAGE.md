# Adding Language Support

## Overview

The annotation system is designed to support multiple content types beyond markdown. This document outlines the architecture and steps needed to add support for new file formats and programming languages.

## Current Architecture

### Core Components

1. **AnnotationRenderer** (`src/components/AnnotationRenderer.tsx`)
   - Main component that orchestrates rendering
   - Already has a `contentType` prop for format selection
   - Delegates to different renderers based on content type

2. **Position Tracking**
   - Character-based offsets (language-agnostic)
   - Works with raw source text
   - Independent of rendering format

3. **Annotation System**
   - Format-agnostic selection storage
   - Positions stored as `{offset, length}` in source text
   - No dependency on markdown-specific features

## Adding a New Language/Format

### Step 1: Define Content Type

Add the new content type to the component's type system:

```typescript
// In AnnotationRenderer.tsx
type ContentType = 'markdown' | 'javascript' | 'python' | 'json' | 'yaml' | 'plaintext';
```

### Step 2: Create Language-Specific Renderer

For syntax-highlighted code languages:

```typescript
// Example: JavaScriptRenderer.tsx
import { Prism } from 'prism-react-renderer';

function JavaScriptRenderer({ 
  content, 
  segments,
  onAnnotationClick,
  onAnnotationRightClick 
}) {
  // Use Prism for syntax highlighting
  const tokens = Prism.tokenize(content, Prism.languages.javascript);
  
  // Apply annotations to tokens
  return renderTokensWithAnnotations(tokens, segments);
}
```

### Step 3: Update Content Type Detection

Implement automatic content type detection based on file extension:

```typescript
function detectContentType(filename: string): ContentType {
  const ext = filename.split('.').pop()?.toLowerCase();
  
  const typeMap: Record<string, ContentType> = {
    'md': 'markdown',
    'mdx': 'markdown',
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'txt': 'plaintext',
  };
  
  return typeMap[ext || ''] || 'plaintext';
}
```

### Step 4: Handle Language-Specific Features

#### For Programming Languages

1. **Syntax Highlighting**
   ```typescript
   import { highlight, languages } from 'prismjs';
   
   const highlighted = highlight(code, languages[lang], lang);
   ```

2. **Token-Aware Annotations**
   - Don't break syntax tokens
   - Respect language keywords
   - Handle comments specially

3. **Smart Selection**
   - Select complete expressions
   - Respect scope boundaries
   - Handle multi-line constructs

#### For Structured Data (JSON/YAML)

1. **Tree Navigation**
   - Allow selecting keys/values
   - Navigate nested structures
   - Collapse/expand sections

2. **Schema Awareness**
   - Validate selections against schema
   - Suggest related fields
   - Type-aware references

### Step 5: Position Mapping Considerations

Different formats require different position mapping strategies:

#### Plain Text / Code
- Direct 1:1 character mapping
- Line/column tracking for debugging

#### Rich Text (HTML/RTF)
- Strip formatting tags for position calculation
- Map between source and rendered positions

#### Binary Formats
- Define meaningful selection units (e.g., cells in spreadsheets)
- Create abstraction layer for position representation

### Step 6: Testing

Add format-specific test cases:

```typescript
describe('Language Support', () => {
  test('JavaScript annotations preserve syntax highlighting', () => {
    const jsCode = `
      function hello() {
        return "world";
      }
    `;
    
    const annotations = [{
      start: 18, // "hello"
      end: 23,
      type: 'highlight'
    }];
    
    // Verify syntax tokens aren't broken
    // Verify highlighting is applied correctly
  });
  
  test('Python respects indentation', () => {
    // Python-specific indentation tests
  });
});
```

## Implementation Checklist

### Required Changes

- [ ] Update `contentType` prop type definition
- [ ] Add language detection logic
- [ ] Create language-specific renderer component
- [ ] Add syntax highlighting library (if needed)
- [ ] Update position mapping for special cases
- [ ] Add language-specific tests
- [ ] Update documentation

### Optional Enhancements

- [ ] Language-specific selection behaviors
- [ ] Syntax-aware annotation suggestions
- [ ] Code intelligence integration (LSP)
- [ ] Format-specific export options
- [ ] Custom annotation types per language

## Language-Specific Considerations

### Markdown
- **Current Status**: ✅ Fully supported
- **Special Features**: Wiki links, heading navigation
- **Challenges**: Position tracking through rendering transforms

### JavaScript/TypeScript
- **Requirements**: Syntax highlighting, JSX support
- **Libraries**: Prism, CodeMirror, Monaco Editor
- **Challenges**: Handling minified code, source maps

### Python
- **Requirements**: Indentation preservation, docstring handling
- **Libraries**: Prism, CodeMirror with Python mode
- **Challenges**: Multi-line strings, significant whitespace

### JSON
- **Requirements**: Tree view, schema validation
- **Libraries**: react-json-view, ajv for validation
- **Challenges**: Large files, circular references

### YAML
- **Requirements**: Indentation handling, multi-document support
- **Libraries**: js-yaml, Prism YAML support
- **Challenges**: Complex references, anchors

### HTML/XML
- **Requirements**: Tag matching, attribute selection
- **Libraries**: parse5, htmlparser2
- **Challenges**: Malformed markup, embedded scripts

### CSV/TSV
- **Requirements**: Column selection, header handling
- **Libraries**: PapaParse, react-csv-reader
- **Challenges**: Large datasets, encoding issues

## Performance Optimization

### For Large Files

1. **Virtualization**
   ```typescript
   import { FixedSizeList } from 'react-window';
   
   // Render only visible lines
   function VirtualizedCodeRenderer({ lines, height }) {
     return (
       <FixedSizeList
         height={height}
         itemCount={lines.length}
         itemSize={20}
       >
         {({ index, style }) => (
           <Line style={style} content={lines[index]} />
         )}
       </FixedSizeList>
     );
   }
   ```

2. **Lazy Annotation Application**
   - Apply annotations only to visible regions
   - Cache processed segments
   - Debounce position calculations

3. **Web Workers**
   - Offload syntax highlighting
   - Background position mapping
   - Parallel annotation processing

## Integration Points

### Backend Requirements

1. **Content Type Storage**
   ```sql
   ALTER TABLE documents 
   ADD COLUMN content_type VARCHAR(50) DEFAULT 'markdown';
   ```

2. **Format Validation**
   ```typescript
   async function validateContent(content: string, type: ContentType) {
     const validator = validators[type];
     return validator ? validator.validate(content) : true;
   }
   ```

3. **Search Integration**
   - Language-aware indexing
   - Syntax-aware search
   - Format-specific filters

### Frontend State Management

```typescript
interface DocumentState {
  content: string;
  contentType: ContentType;
  annotations: Annotation[];
  languageFeatures?: {
    syntaxHighlighting?: boolean;
    codeIntelligence?: boolean;
    formatting?: boolean;
  };
}
```

## Migration Strategy

### Phase 1: Core Support
1. Add contentType field to documents
2. Implement basic rendering for plain text
3. Add language detection

### Phase 2: Syntax Highlighting
1. Integrate Prism.js
2. Add popular languages (JS, Python, Java)
3. Test with real codebases

### Phase 3: Advanced Features
1. Language-specific behaviors
2. Code intelligence
3. Format-specific tools

### Phase 4: Optimization
1. Performance tuning
2. Large file support
3. Caching strategies

## Example: Adding Python Support

```typescript
// 1. Create PythonRenderer.tsx
import Prism from 'prismjs';
import 'prismjs/components/prism-python';

export function PythonRenderer({ content, segments, onAnnotationClick }) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (!containerRef.current) return;
    
    // Apply syntax highlighting
    const highlighted = Prism.highlight(content, Prism.languages.python, 'python');
    containerRef.current.innerHTML = highlighted;
    
    // Apply annotations
    applyAnnotationsToHighlightedCode(containerRef.current, segments);
  }, [content, segments]);
  
  return <div ref={containerRef} className="language-python" />;
}

// 2. Update AnnotationRenderer.tsx
const renderContent = () => {
  if (contentType === 'markdown') {
    // Use CodeMirror for markdown - it handles position mapping correctly!
    const props: any = {
      content,
      segments,
      onAnnotationClick: handleAnnotationClick,
      theme: "light",
      editable: false
    };
    if (onAnnotationRightClick) {
      props.onAnnotationRightClick = onAnnotationRightClick;
    }
    return <CodeMirrorRenderer {...props} />;
  }
  
  // For other content types, render segments directly or use custom renderers
  if (contentType === 'python') {
    return <PythonRenderer ... />;
  }
  
  return <PlainTextRenderer ... />;
};

// 3. Add tests
test('Python annotations work with indentation', () => {
  const pythonCode = `
def hello():
    return "world"
  `;
  
  const annotation = {
    start: 4, // "hello"
    end: 9,
    type: 'highlight'
  };
  
  // Test implementation
});
```

## Conclusion

The annotation system's architecture already supports multiple content types through:
- Abstract position tracking
- Format-agnostic annotation storage
- Pluggable renderer components

Adding new language support primarily requires:
1. Creating a language-specific renderer
2. Handling syntax highlighting
3. Respecting language-specific features
4. Testing edge cases

The system is designed to grow incrementally, allowing new formats to be added without disrupting existing functionality.