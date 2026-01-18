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

### ResourceSearchModal

A specialized modal for searching and selecting resources/documents.

#### Features

- **Resource-Specific Search**: Optimized for document/resource search
- **Metadata Display**: Shows resource type, content preview
- **Initial Search Term**: Can be opened with a pre-filled search
- **Selection Callback**: Returns selected resource ID

#### Props

```typescript
interface ResourceSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (resourceId: string) => void;
  searchTerm?: string;
  translations?: {
    title?: string;
    placeholder?: string;
    searching?: string;
    noResults?: string;
    close?: string;
  };
}
```

#### Usage Example

```tsx
import { ResourceSearchModal } from '@semiont/react-ui';

function ResourcePicker() {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedResource, setSelectedResource] = useState(null);

  const handleSelect = (resourceId: string) => {
    setSelectedResource(resourceId);
    setIsOpen(false);
    // Load or display the selected resource
  };

  return (
    <>
      <button onClick={() => setIsOpen(true)}>
        Select Resource
      </button>

      <ResourceSearchModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onSelect={handleSelect}
        searchTerm=""
        translations={{
          title: 'Search Resources',
          placeholder: 'Search for resources...',
          searching: 'Searching...',
          noResults: 'No documents found'
        }}
      />
    </>
  );
}
```

## Modal Structure

Both modals follow a consistent structure:

```tsx
<Transition>
  <Dialog>
    {/* Backdrop */}
    <div className="backdrop" />

    {/* Modal Panel */}
    <DialogPanel>
      {/* Header */}
      <DialogTitle>Title</DialogTitle>
      <CloseButton />

      {/* Search Input */}
      <SearchInput />

      {/* Results */}
      <ResultsList>
        <ResultItem />
      </ResultsList>

      {/* Footer/Instructions */}
      <KeyboardShortcuts />
    </DialogPanel>
  </Dialog>
</Transition>
```

## Styling

Modal components use BEM-style CSS classes:

```css
/* SearchModal */
.search-modal
.search-modal__backdrop
.search-modal__panel
.search-modal__header
.search-modal__input
.search-modal__results
.search-modal__result-item
.search-modal__result-item--active
.search-modal__empty-state
.search-modal__loading

/* ResourceSearchModal */
.resource-search-modal
.resource-search-modal__header
.resource-search-modal__title
.resource-search-modal__close
.resource-search-modal__input
.resource-search-modal__results
.resource-search-modal__resource
.resource-search-modal__resource--active
.resource-search-modal__resource-name
.resource-search-modal__resource-content
```

## Keyboard Shortcuts

### SearchModal

- **↑/↓**: Navigate results
- **Enter**: Select result
- **ESC**: Close modal
- **⌘K / Ctrl+K**: Open modal (implement in parent)

### ResourceSearchModal

- **ESC**: Close modal
- **Enter**: Submit search
- **Click**: Select resource

## Accessibility Features

- **Focus Management**: Focus trapped within modal when open
- **ARIA Labels**: Proper labeling for screen readers
- **Keyboard Navigation**: Full keyboard support
- **Announcements**: Search results announced to screen readers
- **Semantic HTML**: Proper heading hierarchy and structure

## Integration with Search Hooks

The modals integrate with the `useResources` hook for search functionality:

```tsx
import { ResourceSearchModal, useResources } from '@semiont/react-ui';

function SearchExample() {
  // The modal uses this hook internally
  const resources = useResources();

  // You can also use it externally for custom search
  const { data, isLoading } = resources.search.useQuery(searchTerm, limit);
}
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
  ResourceSearchModalProps,
  BaseModalProps,
  TranslatableModalProps,
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

### Resource Linking

```tsx
// Use ResourceSearchModal for linking resources
function LinkResource({ onLink }) {
  const [isLinking, setIsLinking] = useState(false);

  return (
    <>
      <button onClick={() => setIsLinking(true)}>
        Link Resource
      </button>

      <ResourceSearchModal
        isOpen={isLinking}
        onClose={() => setIsLinking(false)}
        onSelect={(resourceId) => {
          onLink(resourceId);
          setIsLinking(false);
        }}
      />
    </>
  );
}
```

### Contextual Search

```tsx
// Open search with pre-filled term
function ContextualSearch({ selectedText }) {
  const [searchOpen, setSearchOpen] = useState(false);

  const handleSearchSelection = () => {
    setSearchOpen(true);
  };

  return (
    <ResourceSearchModal
      isOpen={searchOpen}
      onClose={() => setSearchOpen(false)}
      searchTerm={selectedText}
      onSelect={handleResourceSelect}
    />
  );
}
```