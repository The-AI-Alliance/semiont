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
- **Result Types**: Renders resource and entity rows; the search it runs returns resources
- **Visual Feedback**: Loading states, empty states, and result highlighting
- **Accessibility**: Full keyboard and screen reader support

#### Props

The props are the component's own — `ComponentProps<typeof SearchModal>`:

- `isOpen`, `onClose` — the parent owns the open state; picking a result calls `onClose` before `onNavigate`.
- `onNavigate(type, id)` — called with the picked result's type (`'resource' | 'entity'`) and id; the host routes.
- `translations` — `placeholder`, `searching`, `noResults`, `startTyping`, `navigate`, `select`, `close`, `enter`, `esc`. All nine are required: the modal has no strings of its own.

#### Usage Example

```tsx
import { SearchModal } from '@semiont/react-ui';

function GlobalSearch() {
  const [isOpen, setIsOpen] = useState(false);

  // The search returns resources
  const handleNavigate = (type: 'resource' | 'entity', id: string) => {
    if (type === 'resource') navigate(routes.resourceDetail(id));
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
          placeholder: t('placeholder'),
          searching: t('searching'),
          noResults: t('noResults'),
          startTyping: t('startTyping'),
          navigate: t('navigate'),
          select: t('select'),
          close: t('close'),
          enter: t('enter'),
          esc: t('esc'),
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
.semiont-search-modal__input-container
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

`SearchModal` drives search through `client.match.resources()` (wired up via
`createSearchPipeline`):

```tsx
import { SearchModal, useSemiont } from '@semiont/react-ui';

// The modal uses the SDK's Observable surface internally:
// client.match.resources(search, { limit }) — debounced via RxJS. The fetch
// closure maps each CacheState emission to the ready ResourceList envelope's
// array: map((st) => readyValue(st)?.resources).
// For custom search elsewhere, use the same approach: see API-INTEGRATION.md.
```

## Platform Integration Examples

### Vite with React Router

The Semiont Browser's own wrapper is `GlobalSearchModal`
(`apps/browser/src/components/modals/GlobalSearchModal.tsx`).

```tsx
import { SearchModal } from '@semiont/react-ui';
import { useNavigate } from 'react-router';

export function ViteSearchModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const navigate = useNavigate();

  return (
    <SearchModal
      isOpen={isOpen}
      onClose={onClose}
      onNavigate={(type, id) => {
        navigate(`/${type}/${id}`);
      }}
      translations={{
        placeholder: t('placeholder'),
        searching: t('searching'),
        noResults: t('noResults'),
        startTyping: t('startTyping'),
        navigate: t('navigate'),
        select: t('select'),
        close: t('close'),
        enter: t('enter'),
        esc: t('esc'),
      }}
    />
  );
}
```

## Type Definitions

Derive the props type from the component:

```typescript
type Props = ComponentProps<typeof SearchModal>;
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
const [searchOpen, setSearchOpen] = useState(false);

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
