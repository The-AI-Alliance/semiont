# Internationalization (i18n)

`@semiont/react-ui` provides internationalization through a `TranslationProvider`, in one of two modes, making it suitable for any React application.

## Overview

The library provides:

1. **Built-in translations** - 29 locales (`AVAILABLE_LOCALES`), each loaded on demand
2. **TranslationManager interface** - Contract for custom implementations
3. **TranslationProvider** - The React Context every translated component reads
4. **useTranslations hook** - Access translations in components

## No Default Language

Nothing in the library assumes a language:

- `useTranslations` throws when there is no `TranslationProvider` above it.
- `TranslationProvider` takes a `locale` or a `translationManager`: one of
  them, and not both.
- A `locale` whose translations cannot be loaded is an error, thrown to the
  nearest error boundary. No other language is shown in its place.

## Two Usage Modes

### 1. Built-in Locale Support

Use the `TranslationProvider` with a `locale` prop to use built-in translations:

```tsx
import { SemiontProvider, TranslationProvider, Toolbar } from '@semiont/react-ui';

function App() {
  return (
    <TranslationProvider locale="es">
      <SemiontProvider>
        <Toolbar context="simple" activePanel={null} />
      </SemiontProvider>
    </TranslationProvider>
  );
}
```

`locale` is one of `AVAILABLE_LOCALES`, which is the list; it is not restated here.

### 2. Custom Translation Implementation

Provide your own translation system via `TranslationManager`. This is especially useful for languages not included in the built-in translations:

```tsx
import { SemiontProvider, TranslationProvider, Toolbar } from '@semiont/react-ui';
import type { TranslationManager } from '@semiont/react-ui';

declare const myTranslations: Record<string, Record<string, string>>; // your app's messages

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
      <SemiontProvider>
        <Toolbar context="simple" activePanel={null} />
      </SemiontProvider>
    </TranslationProvider>
  );
}
```

#### Example: Adding Klingon Translations (Not Built-in)

Here's how you'd add support for Klingon, a language not included in react-ui:

```tsx
import { TranslationProvider } from '@semiont/react-ui';
import type { TranslationManager } from '@semiont/react-ui';

// Klingon translations for react-ui components
const klingonTranslations: Record<string, Record<string, string>> = {
  Toolbar: {
    annotations: 'DIch',           // "annotations"
    resourceInfo: 'teywI\' nugh',  // "resource info"
    history: 'qej',                // "history"
    collaboration: 'jup DIlo\'',   // "collaboration"
    userAccount: 'lo\'wI\' DIch',  // "user account"
    settings: 'nugh choq',         // "settings"
    knowledgeBase: 'Sov qach',     // "knowledge base"
  },
  // ... add more namespaces as needed
};

const klingonTranslationManager: TranslationManager = {
  t: (namespace: string, key: string) => {
    // Return Klingon translation or fall back to the key
    return klingonTranslations[namespace]?.[key] || key;
  }
};

// Use throughout your app
function KlingonApp({ children }: { children: React.ReactNode }) {
  return (
    <TranslationProvider translationManager={klingonTranslationManager}>
      {/* All components use Klingon translations */}
      {children}
    </TranslationProvider>
  );
}
```

This approach works for any language or constructed language (Elvish, Dothraki, Esperanto, etc.) that isn't included in the built-in translations.

## Benefits

This approach allows apps to:
- ✅ Use built-in translations for rapid prototyping
- ✅ Integrate with any i18n library (react-i18next, FormatJS, custom)
- ✅ Choose their own translation file format (JSON, YAML, TypeScript, API)
- ✅ Support any set of languages
- ✅ Implement custom translation logic (pluralization, interpolation, etc.)
- ✅ Optimized bundle size: every built-in locale is loaded on demand

## Implementation Guide

### 1. Define TranslationManager

Implement the `TranslationManager` interface — one method,
`t(namespace, key, params?)`, returning the string to show:

```typescript
import type { TranslationManager } from '@semiont/react-ui';

const echo: TranslationManager = {
  t: (namespace, key) => `${namespace}.${key}`,
};
```

### 2. Example: Using react-i18next

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

The Semiont Browser's manager, `useMergedTranslationManager`
(`apps/browser/src/hooks/useMergedTranslationManager.ts`), reads the active
locale's bundle from i18next and interpolates it with `interpolateTranslation`,
the function the built-in managers use.

### 3. Example: Custom Implementation

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

### 4. Provide to App

```tsx
// app/providers.tsx
import { TranslationProvider } from '@semiont/react-ui';

declare function useTranslationManager(): TranslationManager; // one of the hooks above

export function Providers({ children }: { children: React.ReactNode }) {
  const translationManager = useTranslationManager();

  return (
    <TranslationProvider translationManager={translationManager}>
      {children}
    </TranslationProvider>
  );
}
```

### 5. Use in Components

```tsx
import { useTranslations } from '@semiont/react-ui';

function PanelButtons() {
  const t = useTranslations('Toolbar');

  return (
    <div>
      <button>{t('history')}</button>
      <button>{t('settings')}</button>
      <button>{t('userAccount')}</button>
    </div>
  );
}
```

## Translation Namespaces

The library uses **namespace-based** translations. Each component or feature
area has its own namespace, named after it: a modal's copy is under the modal's
name, read with `useTranslations('SessionEndedModal')`.

The namespaces are the top-level keys of `translations/en.json`, which is the
list; it is not restated here. Every locale has every namespace and every key:
`npm run lint:translations` fails the build on any key missing from, or extra
in, any locale.

## Translation File Structure

One JSON file per locale, namespaces at the top level (an excerpt of
`translations/en.json`):

```json
{
  "Toolbar": {
    "annotations": "Annotations",
    "history": "History",
    "resourceInfo": "Resource Info",
    "collaboration": "Collaboration",
    "userAccount": "User Account",
    "settings": "Settings",
    "knowledgeBase": "Knowledge Base"
  },
  "SessionEndedModal": {
    "title": "Signed Out",
    "expired": "Your session has expired. Please sign in again.",
    "refused": "This knowledge base did not accept your sign-in. Please sign in again.",
    "goHome": "Go to Home",
    "signInAgain": "Sign In Again"
  }
}
```

### TypeScript Type Safety

For type-safe translations, derive the types from the English messages:

```typescript
// types/translations.ts
import en from '@semiont/react-ui/translations/en';

export type TranslationNamespace = keyof typeof en & string;
export type TranslationKey<NS extends TranslationNamespace> = keyof (typeof en)[NS] & string;

// Usage with stronger typing
function useTypedTranslations<NS extends TranslationNamespace>(namespace: NS) {
  const t = useTranslations(namespace);
  return (key: TranslationKey<NS>) => t(key);
}
```

## Interpolation and Pluralization

`t` receives the call's `params`; interpolation and pluralization are the
manager's to implement. The built-in managers use `interpolateTranslation`,
which a custom manager can call for the same result. In one pass over the
string it resolves ICU plural expressions and replaces `{{name}}` with
`params.name`:

```tsx
import { interpolateTranslation, type TranslationManager } from '@semiont/react-ui';

declare const locale: string; // the language the messages are written in
declare const messages: Record<string, Record<string, string>>; // the active locale's messages

const manager: TranslationManager = {
  t: (namespace, key, params = {}) => {
    const message = messages[namespace]?.[key] ?? `${namespace}.${key}`;

    // "Page {{page}} of {{total}}" -> "Page 3 of 12"
    return interpolateTranslation(message, params, locale);
  },
};

// Usage
const t = useTranslations('PdfViewer');
const pageLabel = t('pageOf', { page: 3, total: 12 });
// "Page 3 of 12"
```

A plural expression names a param and gives a branch per case:

```json
{
  "found": "Found {count, plural, =0 {nothing} one {# item} other {# items}} in {{scope}}"
}
```

- A branch is chosen by exact count (`=0`, `=1`, …) first, then by the plural
  category the count falls in (`zero`, `one`, `two`, `few`, `many`), then
  `other`. The categories are the locale's: English has `one` and `other`,
  Polish has `one`, `few`, `many` and `other`.
- `#` in a branch stands for the count.
- A string may hold several plural expressions, and a branch may hold
  `{{name}}` placeholders and further plural expressions.
- A value goes in as written: a count or a param's value that itself holds
  `{{name}}`, `#` or a plural expression is text, not more template.
- What cannot be resolved is left as written, whole: a placeholder or plural
  whose param is not passed, a plural with no branch for the count, and a
  plural that never closes together with what follows it.

## Language Switching

Switching languages is the host's job. react-ui's `SettingsPanel` emits
`settings:locale-changed` with the chosen locale; the host applies it — the
Semiont Browser re-routes to the same path under the new locale prefix:

```tsx
import { useEventSubscription } from '@semiont/react-ui';

function LocaleSwitching() {
  useEventSubscription('settings:locale-changed', ({ locale }) => {
    navigate(pathname.replace(/^\/[^/]+/, `/${locale}`));
  });
  return null;
}
```

## RTL (Right-to-Left) Support

The library doesn't enforce RTL. Implement in your app:

```tsx
function DirectionalRoot({ children }: { children: React.ReactNode }) {
  const direction = locale === 'ar' || locale === 'he' || locale === 'fa' ? 'rtl' : 'ltr';

  return (
    <div lang={locale} dir={direction}>
      {children}
    </div>
  );
}
```

## Testing Translations

Use the test utilities to provide mock translations:

```tsx
import { renderWithProviders, createMockTranslationManager, screen } from '@semiont/react-ui/test-utils';

it('should display translated text', () => {
  const translations = createMockTranslationManager({
    Toolbar: {
      settings: 'Ajustes',
      userAccount: 'Cuenta'
    }
  });

  renderWithProviders(<Toolbar context="simple" activePanel={null} />, {
    translationManager: translations
  });

  expect(screen.queryByRole('button', { name: 'Ajustes' })).not.toBeNull();
});
```

Or render under react-ui's own English strings, for a test that asserts on the copy:

```tsx
import { useTranslations } from '@semiont/react-ui';
import { renderInEnglish, screen } from '@semiont/react-ui/test-utils';

function SettingsButton() {
  const t = useTranslations('Toolbar');
  return <button>{t('settings')}</button>;
}

it('should name the button in English', () => {
  renderInEnglish(<SettingsButton />);

  expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeNull();
});
```

`englishTranslationManager` is the manager behind it, for a test that mounts
its own providers.

Or use the default mock (returns `"Namespace.key"`):

```tsx
import { renderWithProviders, screen } from '@semiont/react-ui/test-utils';

it('should render with default translations', () => {
  renderWithProviders(<Toolbar context="simple" activePanel={null} />);

  expect(screen.queryByRole('button', { name: 'Toolbar.settings' })).not.toBeNull();
});
```

## Best Practices

### ❌ Don't: Call hooks conditionally

```tsx
// WRONG - Violates Rules of Hooks
export function useTranslationManager(): TranslationManager {
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
const history = t('history');
const settings = t('settings');
```

### ❌ Don't: Mix namespaces unnecessarily

```tsx
// Avoid switching namespaces mid-component
const toolbarT = useTranslations('Toolbar');
const settingsT = useTranslations('Settings');
const shortcutsT = useTranslations('KeyboardShortcuts'); // Too many!
```

### ✅ Do: Provide fallbacks

```tsx
declare const messages: Record<string, Record<string, string>>; // the active locale's messages

const manager: TranslationManager = {
  t: (namespace, key) => messages[namespace]?.[key] ?? `${namespace}.${key}`, // Fallback to the key path
};
```

## Performance & Dynamic Loading

### Bundle Size Optimization

The library loads every built-in locale with a dynamic import:

- **No locale is in the main bundle**: each is fetched when a `TranslationProvider` asks for it
- **Caching**: Loaded translations are cached for the session

### Adding New Locales

To add support for another locale:

1. Add the translation file, `translations/<code>.json`, with every namespace and key (`npm run lint:translations` checks)
2. Add the code to the `AVAILABLE_LOCALES` constant in `packages/react-ui/src/contexts/TranslationContext.tsx` (a test fails when the constant and the translation files differ)
3. The locale will be dynamically loaded when used

### Preloading Translations

Use the `usePreloadTranslations` hook to preload translations before they're needed:

```tsx
import { usePreloadTranslations } from '@semiont/react-ui';

function LanguageSwitcher() {
  const { preload, isLoaded } = usePreloadTranslations();

  // Preload on hover for instant switching
  const handleHover = (locale: string) => {
    if (!isLoaded(locale)) {
      preload(locale);
    }
  };

  return (
    <select>
      <option value="en" onMouseEnter={() => handleHover('en')}>English</option>
      <option value="es" onMouseEnter={() => handleHover('es')}>Español</option>
    </select>
  );
}
```

### Loading State

`TranslationProvider` renders its children once the locale's translations are
loaded, and until then renders `loadingComponent` (nothing, when none is given):

```tsx
<TranslationProvider
  locale="es"
  loadingComponent={<div>Loading translations...</div>}
>
  {children}
</TranslationProvider>
```

## See Also

- [SESSION.md](SESSION.md) - Provider Pattern details
- [TESTING.md](TESTING.md) - Testing with translations
- [COMPONENTS.md](COMPONENTS.md) - Components that use translations
