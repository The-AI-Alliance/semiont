# Internationalization (i18n)

`@semiont/react-ui` provides flexible internationalization support with three usage modes, making it suitable for any React application.

## Overview

The library provides:

1. **Built-in translations** - English and Spanish translations included
2. **TranslationManager interface** - Contract for custom implementations
3. **TranslationProvider** - Optional React Context for configuration
4. **useTranslations hook** - Access translations in components

## Three Usage Modes

### 1. Default English (No Configuration Required)

Components work out-of-the-box with English translations - no provider needed:

```tsx
import { Toolbar } from '@semiont/react-ui';

// Components use default English translations
function App() {
  return <Toolbar context="simple" />;
}
```

### 2. Built-in Locale Support (English & Spanish)

Use the `TranslationProvider` with a `locale` prop to use built-in translations:

```tsx
import { TranslationProvider, Toolbar } from '@semiont/react-ui';

function App() {
  return (
    <TranslationProvider locale="es">
      <Toolbar context="simple" />
    </TranslationProvider>
  );
}
```

Available locales:
- `en` - English (default)
- `es` - Spanish

### 3. Custom Translation Implementation

Provide your own translation system via `TranslationManager`:

```tsx
import { TranslationProvider, Toolbar } from '@semiont/react-ui';
import type { TranslationManager } from '@semiont/react-ui';

const myTranslationManager: TranslationManager = {
  t: (namespace: string, key: string, params?: Record<string, any>) => {
    // Your custom translation logic here
    // Could integrate with react-i18next, react-intl, etc.
    return myTranslations[namespace]?.[key] || `${namespace}.${key}`;
  },
};

function App() {
  return (
    <TranslationProvider translationManager={myTranslationManager}>
      <Toolbar context="simple" />
    </TranslationProvider>
  );
}
```

## Benefits

This approach allows apps to:
- ✅ Work immediately with zero configuration
- ✅ Use built-in translations for rapid prototyping
- ✅ Integrate with any i18n library (next-intl, react-i18next, FormatJS, custom)
- ✅ Choose their own translation file format (JSON, YAML, TypeScript, API)
- ✅ Support any set of languages
- ✅ Implement custom translation logic (pluralization, interpolation, etc.)

## Implementation Guide

### 1. Define TranslationManager

Create a hook that implements the `TranslationManager` interface:

```typescript
import { TranslationManager } from '@semiont/react-ui';

interface TranslationManager {
  t: (namespace: string, key: string) => string;
}
```

### 2. Example: Using next-intl

```tsx
// app/hooks/useTranslationManager.ts
import { useLocale } from 'next-intl';
import { useMemo } from 'react';
import type { TranslationManager } from '@semiont/react-ui';

// Import all message files
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import fr from '@/messages/fr.json';

const messages = { en, es, fr };

export function useTranslationManager(): TranslationManager {
  const locale = useLocale();

  return useMemo(() => ({
    t: (namespace: string, key: string) => {
      const localeMessages = messages[locale] || messages.en;
      const namespaceMessages = localeMessages[namespace];
      return namespaceMessages?.[key] || key; // Fallback to key
    }
  }), [locale]);
}
```

### 3. Example: Using react-i18next

```tsx
// src/hooks/useTranslationManager.ts
import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import type { TranslationManager } from '@semiont/react-ui';

export function useTranslationManager(): TranslationManager {
  const { i18n } = useTranslation();

  return useMemo(() => ({
    t: (namespace: string, key: string) => {
      return i18n.t(`${namespace}.${key}`);
    }
  }), [i18n]);
}
```

### 4. Example: Custom Implementation

```tsx
// src/hooks/useTranslationManager.ts
import { useState, useMemo } from 'react';
import type { TranslationManager } from '@semiont/react-ui';

export function useTranslationManager(): TranslationManager {
  const [locale, setLocale] = useState('en');

  return useMemo(() => ({
    t: (namespace: string, key: string) => {
      // Your custom translation logic
      // Could fetch from API, use localStorage, etc.
      return `${locale}:${namespace}.${key}`;
    }
  }), [locale]);
}
```

### 5. Provide to App

```tsx
// app/providers.tsx
import { TranslationProvider } from '@semiont/react-ui';
import { useTranslationManager } from './hooks/useTranslationManager';

export function Providers({ children }) {
  const translationManager = useTranslationManager();

  return (
    <TranslationProvider translationManager={translationManager}>
      {children}
    </TranslationProvider>
  );
}
```

### 6. Use in Components

```tsx
import { useTranslations } from '@semiont/react-ui';

function Toolbar() {
  const t = useTranslations('Toolbar');

  return (
    <div>
      <button>{t('save')}</button>
      <button>{t('cancel')}</button>
      <button>{t('delete')}</button>
    </div>
  );
}
```

## Translation Namespaces

The library uses **namespace-based** translations. Each component or feature area has its own namespace.

### Common Namespaces

**Shared UI Strings:**
- `Common` - save, cancel, delete, edit, close, loading, error

**Navigation:**
- `Navigation` - home, know, moderate, administer
- `Footer` - copyright, about, privacyPolicy, termsOfService, apiDocs, sourceCode, keyboardShortcuts

**User Interface:**
- `Settings` - title, lineNumbers, theme, language
- `Toolbar` - Various toolbar actions
- `AnnotateToolbar` - Annotation tools
- `ResourceViewer` - Resource viewing UI

**Modals:**
- `KeyboardShortcutsModal` - Keyboard shortcuts help
- `SessionExpiredModal` - Session expiration messages
- `ProposeEntitiesModal` - Entity proposal UI

**Resource Management:**
- `ResourceInfoPanel` - Resource metadata
- `TaggingPanel` - Tagging interface
- `CommentsPanel` - Comments UI
- `ReferencesPanel` - References display
- `AssessmentPanel` - Assessment interface

**Annotations:**
- `HighlightPanel` - Highlight annotations
- `JsonLdPanel` - JSON-LD view
- `DetectSection` - Entity detection

## Translation File Structure

### Recommended Structure (JSON)

```json
{
  "Common": {
    "save": "Save",
    "cancel": "Cancel",
    "delete": "Delete",
    "edit": "Edit",
    "close": "Close",
    "loading": "Loading...",
    "error": "An error occurred"
  },
  "Toolbar": {
    "save": "Save",
    "undo": "Undo",
    "redo": "Redo",
    "bold": "Bold",
    "italic": "Italic"
  },
  "Navigation": {
    "home": "Home",
    "know": "Know",
    "moderate": "Moderate",
    "administer": "Administer"
  },
  "Footer": {
    "copyright": "© {year} Semiont. All rights reserved.",
    "about": "About",
    "privacyPolicy": "Privacy Policy",
    "termsOfService": "Terms of Service",
    "apiDocs": "API Docs",
    "sourceCode": "Source Code",
    "keyboardShortcuts": "Keyboard Shortcuts"
  }
}
```

### TypeScript Type Safety

For type-safe translations, generate types from your message files:

```typescript
// types/translations.ts
import en from '@/messages/en.json';

export type TranslationNamespace = keyof typeof en;
export type TranslationKey<NS extends TranslationNamespace> = keyof typeof en[NS];

// Usage with stronger typing
function useTypedTranslations<NS extends TranslationNamespace>(namespace: NS) {
  const t = useTranslations(namespace);
  return (key: TranslationKey<NS>) => t(key);
}
```

## Interpolation and Pluralization

The `TranslationManager` interface returns strings. If you need interpolation or pluralization, implement it in your manager:

```tsx
interface AdvancedTranslationManager extends TranslationManager {
  t: (namespace: string, key: string, params?: Record<string, any>) => string;
}

export function useTranslationManager(): AdvancedTranslationManager {
  const locale = useLocale();

  return {
    t: (namespace, key, params = {}) => {
      let message = messages[locale]?.[namespace]?.[key] || key;

      // Simple interpolation: "Hello {name}" -> "Hello John"
      Object.entries(params).forEach(([k, v]) => {
        message = message.replace(`{${k}}`, String(v));
      });

      return message;
    }
  };
}

// Usage
const t = useTranslations('Footer');
const copyright = t('copyright', { year: 2024 });
// "© 2024 Semiont. All rights reserved."
```

**Note:** If you extend the interface, you'll need to cast in components:

```tsx
const manager = useContext(TranslationContext) as AdvancedTranslationManager;
const t = (key: string, params?: any) => manager.t('Toolbar', key, params);
```

## Language Switching

Implement language switching in your app:

```tsx
// With next-intl
import { useRouter, usePathname } from 'next/navigation';

export function LanguageSwitcher() {
  const router = useRouter();
  const pathname = usePathname();

  const switchLocale = (locale: string) => {
    const newPath = pathname.replace(/^\/[^/]+/, `/${locale}`);
    router.push(newPath);
  };

  return (
    <select onChange={(e) => switchLocale(e.target.value)}>
      <option value="en">English</option>
      <option value="es">Español</option>
      <option value="fr">Français</option>
    </select>
  );
}
```

## RTL (Right-to-Left) Support

The library doesn't enforce RTL. Implement in your app:

```tsx
// app/layout.tsx
export default function RootLayout({ children }) {
  const locale = useLocale();
  const direction = locale === 'ar' || locale === 'he' ? 'rtl' : 'ltr';

  return (
    <html lang={locale} dir={direction}>
      <body>{children}</body>
    </html>
  );
}
```

## Testing Translations

Use the test utilities to provide mock translations:

```tsx
import { renderWithProviders, createMockTranslationManager } from '@semiont/react-ui/test-utils';

it('should display translated text', () => {
  const translations = createMockTranslationManager({
    Toolbar: {
      save: 'Guardar',
      cancel: 'Cancelar'
    }
  });

  renderWithProviders(<Toolbar />, {
    translationManager: translations
  });

  expect(screen.getByText('Guardar')).toBeInTheDocument();
});
```

Or use the default mock (returns `"Namespace.key"`):

```tsx
it('should render with default translations', () => {
  renderWithProviders(<Toolbar />);

  expect(screen.getByText('Toolbar.save')).toBeInTheDocument();
});
```

## Migration from next-intl

If you're migrating from direct `next-intl` usage:

**Before (coupled to next-intl):**
```tsx
import { useTranslations } from 'next-intl';

function Toolbar() {
  const t = useTranslations('Toolbar');
  return <button>{t('save')}</button>;
}
```

**After (framework-agnostic):**
```tsx
import { useTranslations } from '@semiont/react-ui';

function Toolbar() {
  const t = useTranslations('Toolbar');
  return <button>{t('save')}</button>;
}
```

The API is identical, but now the implementation comes from your app's `TranslationManager`, not directly from next-intl.

## Best Practices

### ✅ Do: Load messages statically

```tsx
import en from '@/messages/en.json';
import es from '@/messages/es.json';

const messages = { en, es };

export function useTranslationManager(): TranslationManager {
  const locale = useLocale();

  return {
    t: (namespace, key) => messages[locale]?.[namespace]?.[key] || key
  };
}
```

### ❌ Don't: Call hooks conditionally

```tsx
// WRONG - Violates Rules of Hooks
export function useTranslationManager(): TranslationManager {
  const locale = useLocale();

  return {
    t: (namespace, key) => {
      const translator = useTranslations(namespace); // ❌ Can't call hooks here
      return translator(key);
    }
  };
}
```

### ✅ Do: Keep namespaces consistent

```tsx
// All "Toolbar" translations together
const t = useTranslations('Toolbar');
const save = t('save');
const cancel = t('cancel');
```

### ❌ Don't: Mix namespaces unnecessarily

```tsx
// Avoid switching namespaces mid-component
const toolbarT = useTranslations('Toolbar');
const commonT = useTranslations('Common');
const footerT = useTranslations('Footer'); // Too many!
```

### ✅ Do: Provide fallbacks

```tsx
t: (namespace, key) => {
  return messages[locale]?.[namespace]?.[key] || key; // Fallback to key
}
```

### ✅ Do: Document your translation keys

Create a types file documenting all namespaces and keys:

```typescript
// types/translations.d.ts
export type TranslationNamespaces = {
  Common: 'save' | 'cancel' | 'delete' | 'edit' | 'close';
  Toolbar: 'save' | 'undo' | 'redo' | 'bold' | 'italic';
  Navigation: 'home' | 'know' | 'moderate' | 'administer';
  // ... etc
};
```

## See Also

- [PROVIDERS.md](PROVIDERS.md) - Provider Pattern details
- [TESTING.md](TESTING.md) - Testing with translations
- [COMPONENTS.md](COMPONENTS.md) - Components that use translations
