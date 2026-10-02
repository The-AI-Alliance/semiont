# Modal Components

This document describes the modal components available in @semiont/react-ui.

## Overview

The modal components provide reusable, accessible dialog interfaces that work across different React frameworks. They use HeadlessUI under the hood for accessibility and are designed to accept platform-specific navigation handlers and translations.

## Components

### SearchModal

A comprehensive global search modal with keyboard navigation and real-time search results.

#### Features

- **Real-time Search**: Debounced search with loading states
- **Keyboard Navigation**: Arrow keys to navigate, Enter to select, ESC to close
- **Result Types**: Supports different result types (resources, entities, etc.)
- **Visual Feedback**: Loading states, empty states, and result highlighting
- **Accessibility**: Full keyboard and screen reader support

#### Props

```typescript
interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (type: 'resource' | 'entity', id: string) => void;
  translations?: {
    placeholder?: string;
    searching?: string;
    noResults?: string;
    startTyping?: string;
    navigate?: string;
    select?: string;
    close?: string;
    enter?: string;
    esc?: string;
  };
}
```

#### Usage Example

```tsx
import { SearchModal } from '@semiont/react-ui';
import { useRouter } from 'next/navigation';

function GlobalSearch() {
  const [isOpen, setIsOpen] = useState(false);
  const router = useRouter();

  const handleNavigate = (type: 'resource' | 'entity', id: string) => {
    if (type === 'resource') {
      router.push(`/resource/${id}`);
    } else {
      router.push(`/entity/${id}`);
    }
    setIsOpen(false);
  };

  return (
    <>
      <button onClick={() => setIsOpen(true)}>
        Search (⌘K)
      </button>

      <SearchModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onNavigate={handleNavigate}
        translations={{
          placeholder: 'Search resources, entities...',
          searching: 'Searching...',
          noResults: 'No results found',
          startTyping: 'Start typing to search'
        }}
      />
    </>
  );
}
```

## Styling

Modal components use BEM-style CSS classes:

```css
/* SearchModal */
.semiont-search-modal
.semiont-search-modal__backdrop
.semiont-search-modal__panel
.semiont-search-modal__header
.semiont-search-modal__input
.semiont-search-modal__results
.semiont-search-modal__result
.semiont-search-modal__result--selected
.semiont-search-modal__empty
```

## Keyboard Shortcuts

### SearchModal

- **↑/↓**: Navigate results
- **Enter**: Select result
- **ESC**: Close modal
- **⌘K / Ctrl+K**: Open modal (implement in parent)

## Accessibility Features

- **Focus Management**: Focus trapped within modal when open
- **ARIA Labels**: Proper labeling for screen readers
- **Keyboard Navigation**: Full keyboard support
- **Announcements**: Search results announced to screen readers
- **Semantic HTML**: Proper heading hierarchy and structure

## Integration with Search

`SearchModal` drives search through `client.browse.resources()` (wired up via
`createSearchPipeline`):

```tsx
import { SearchModal, useSemiont } from '@semiont/react-ui';

// The modal uses the SDK's Observable surface internally:
// client.browse.resources({ search, limit }) — debounced via RxJS. The fetch
// closure maps each CacheState emission to the ready ResourceList envelope's
// array: map((st) => readyValue(st)?.resources).
// For custom search elsewhere, use the same approach: see API-INTEGRATION.md.
```

## Platform Integration Examples

### Next.js with App Router

```tsx
import { SearchModal } from '@semiont/react-ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

export function NextSearchModal({ isOpen, onClose }) {
  const router = useRouter();
  const t = useTranslations('Search');

  return (
    <SearchModal
      isOpen={isOpen}
      onClose={onClose}
      onNavigate={(type, id) => {
        router.push(`/${type}/${id}`);
      }}
      translations={{
        placeholder: t('placeholder'),
        searching: t('searching'),
        // ... other translations
      }}
    />
  );
}
```

### Vite with React Router

```tsx
import { SearchModal } from '@semiont/react-ui';
import { useNavigate } from 'react-router-dom';

export function ViteSearchModal({ isOpen, onClose }) {
  const navigate = useNavigate();

  return (
    <SearchModal
      isOpen={isOpen}
      onClose={onClose}
      onNavigate={(type, id) => {
        navigate(`/${type}/${id}`);
      }}
      translations={{
        placeholder: 'Search...',
        // ... translations
      }}
    />
  );
}
```

## Type Definitions

All modal types are exported:

```typescript
import type {
  SearchModalProps,
  BaseModalProps,
  NavigableModalProps
} from '@semiont/react-ui';
```

## Best Practices

1. **Always Provide Translations**: Pass all UI text as props for i18n support
2. **Handle Navigation Externally**: Let the parent component handle routing
3. **Manage State in Parent**: Control `isOpen` state from parent component
4. **Debounce Search Input**: Modals include built-in debouncing (300ms)
5. **Show Loading States**: Modals display loading indicators during search
6. **Provide Empty States**: Clear messaging when no results found
7. **Test Keyboard Navigation**: Ensure all features work without mouse

## Common Use Cases

### Global Command Palette

```tsx
// Add keyboard shortcut to open search
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setSearchOpen(true);
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, []);
```
