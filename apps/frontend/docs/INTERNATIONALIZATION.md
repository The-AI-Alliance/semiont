# Internationalization (i18n) Guide

**Last Updated**: 2026-01-12

## Overview

Internationalization in Semiont follows the framework-agnostic architecture established by @semiont/react-ui:

- **Provider Pattern**: @semiont/react-ui defines a `TranslationProvider` interface
- **Framework Implementation**: Frontend implements this interface using `next-intl`
- **Component Translations**: UI components use translations through the provider
- **Dynamic Loading**: Optimal bundle size through code-splitting

## Architecture

```
┌─────────────────────────────────────┐
│         apps/frontend               │
│                                     │
│  Implements TranslationProvider:    │
│  • Uses next-intl for i18n         │
│  • Provides locale routing          │
│  • Manages translation files        │
└─────────────┬───────────────────────┘
              │ provides
              ▼
┌─────────────────────────────────────┐
│    packages/react-ui                │
│                                     │
│  Uses TranslationProvider:          │
│  • Components call useTranslations()│
│  • Framework-agnostic API           │
│  • No direct next-intl dependency   │
└─────────────────────────────────────┘
```

### Translation Provider Pattern

The frontend implements the TranslationProvider interface:

```typescript
// apps/frontend/src/app/providers/TranslationProvider.tsx
import { TranslationProvider } from '@semiont/react-ui';
import { useTranslations, useLocale } from 'next-intl';

export function NextIntlTranslationProvider({ children }) {
  const t = useTranslations();
  const locale = useLocale();

  const translationManager = {
    // Core translation function
    t: (key: string, params?: Record<string, any>) => {
      return t(key, params);
    },

    // Current locale
    locale: locale,

    // Available locales
    availableLocales: ['en', 'es', 'fr'],

    // Change locale (Next.js routing)
    setLocale: (newLocale: string) => {
      router.push(pathname, { locale: newLocale });
    },

    // Format functions
    formatDate: (date: Date) => {
      return new Intl.DateTimeFormat(locale).format(date);
    },

    formatNumber: (num: number) => {
      return new Intl.NumberFormat(locale).format(num);
    }
  };

  return (
    <TranslationProvider translationManager={translationManager}>
      {children}
    </TranslationProvider>
  );
}
```

### Using Translations in Components

Components from @semiont/react-ui use translations through the provider:

```typescript
// In @semiont/react-ui components
import { useTranslations } from '../contexts/TranslationContext';

export function ResourceViewer() {
  const { t } = useTranslations();

  return (
    <div>
      <h1>{t('resource.title')}</h1>
      <button>{t('common.save')}</button>
    </div>
  );
}
```

### Translation File Organization

**Frontend Messages** (`apps/frontend/messages/`)
```
messages/
├── en.json          # English (default)
├── es.json          # Spanish
└── fr.json          # French
```

**Component Translations** (embedded in provider)
Components get translations through the provider, which merges:
- Frontend-specific translations from `messages/*.json`
- Common UI translations defined by the provider implementation

## Adding a New Language

Since @semiont/react-ui is framework-agnostic, adding a new language only requires frontend configuration:

### Step 1: Add Translation Files

1. Create a new message file for the frontend:
   ```bash
   cp messages/en.json messages/fr.json
   ```

2. Translate all keys in `messages/fr.json`

### Step 2: Configure Next.js for the New Locale

1. Add locale to Next.js i18n config:
   ```typescript
   // src/i18n/config.ts
   export const locales = ['en', 'es', 'fr'] as const;
   ```

2. Update middleware to support the new locale:
   ```typescript
   // apps/frontend/src/middleware.ts
   const locales = ['en', 'es', 'fr'];
   ```

### Step 3: Update Translation Provider

1. Update the provider to include the new locale:
   ```typescript
   // apps/frontend/src/app/providers/TranslationProvider.tsx
   const translationManager = {
     availableLocales: ['en', 'es', 'fr'],  // Add 'fr'
     // ... rest of configuration
   };
   ```

2. Add locale display names:
   ```typescript
   // apps/frontend/src/lib/locales.ts
   export const localeNames = {
     en: 'English',
     es: 'Español',
     fr: 'Français',  // Add this
   };
   ```

### Step 4: Verify Component Translations

Since @semiont/react-ui components use the TranslationProvider, they automatically work with the new locale. The provider implementation handles:
- Loading the correct message file
- Providing translations to components
- Formatting dates/numbers for the locale

## Translation Keys Structure

### Namespaces

Translations are organized by namespace:

**Frontend Namespaces:**
- `Home` - Landing page
- `Auth` - Authentication pages
- `Discover` - Resource discovery
- `Compose` - Document composition
- `Admin` - Admin sections

**Component Namespaces (react-ui):**
- `Common` - Shared UI strings
- `Toolbar` - Toolbar actions
- `Navigation` - Navigation elements
- `Footer` - Footer content
- `Settings` - Settings UI
- Panel components (ResourceInfoPanel, TaggingPanel, etc.)

### Key Naming Conventions

- Use camelCase for keys: `saveButton`, `confirmMessage`
- Group related keys: `form.title`, `form.submit`, `form.cancel`
- Use descriptive names: `resourceNotFoundError` not `error1`
- Include context: `deleteResourceConfirmation` not just `confirmation`

## Parameter Interpolation

Both systems support parameter interpolation:

```typescript
// In translation file
{
  "welcome": "Welcome, {name}!",
  "itemCount": "{count} {count, plural, one {item} other {items}}"
}

// Usage
t('welcome', { name: 'John' })  // "Welcome, John!"
t('itemCount', { count: 5 })    // "5 items"
```

## Testing Translations

### Unit Tests

Use mock translation managers in tests:

```typescript
import { renderWithProviders } from '@semiont/react-ui/test-utils';

it('should display translated text', () => {
  const translations = {
    Toolbar: {
      save: 'Guardar',
      cancel: 'Cancelar'
    }
  };

  renderWithProviders(<Toolbar />, {
    translationManager: createMockTranslationManager(translations)
  });

  expect(screen.getByText('Guardar')).toBeInTheDocument();
});
```

### E2E Testing

Test different locales:

```typescript
test('should work in Spanish', async ({ page }) => {
  await page.goto('/es');
  await expect(page.locator('text=Guardar')).toBeVisible();
});
```

## Performance Optimization

### Dynamic Loading

Non-English translations are loaded on-demand:

```typescript
// React-UI uses dynamic imports for locales
async function loadTranslations(locale: string): Promise<any> {
  const translations = await import(`../../translations/${locale}.json`);
  return translations.default;
}
```

This results in:
- Smaller initial bundle (only English included)
- Separate chunks for each locale
- Cached after first load

### Preloading

Preload translations for better UX:

```typescript
import { usePreloadTranslations } from '@semiont/react-ui';

function LanguageSwitcher() {
  const { preload } = usePreloadTranslations();

  // Preload on hover
  const handleHover = (locale: string) => {
    preload(locale);
  };

  return (
    <select>
      <option onMouseEnter={() => handleHover('es')}>Español</option>
    </select>
  );
}
```

## Common Issues & Solutions

### Missing Translations

**Problem**: Key shows as `Namespace.key` instead of translated text

**Solution**:
1. Check key exists in translation file
2. Verify namespace is correct
3. Ensure locale is loaded

### Parameter Not Replaced

**Problem**: Seeing `{name}` in output instead of value

**Solution**: Pass params object to translation function:
```typescript
// Wrong
t('welcome')

// Right
t('welcome', { name: userName })
```

### Component Translations Not Loading

**Problem**: React-UI components showing English when locale is Spanish

**Solution**: Ensure TranslationProvider wraps the component tree:
```typescript
<TranslationProvider translationManager={translationManager}>
  <YourApp />
</TranslationProvider>
```

## Best Practices

1. **Keep translations close to usage**: Component-specific translations in react-ui, page-specific in frontend

2. **Avoid hardcoding**: Never hardcode display text, always use translation keys

3. **Provide context**: Use descriptive namespaces and keys

4. **Test all locales**: Include translation tests in your test suite

5. **Handle missing translations gracefully**: Always provide fallbacks

6. **Use TypeScript**: Type your translation keys for better DX:
   ```typescript
   type TranslationKey = 'save' | 'cancel' | 'delete';
   ```

## Migration Notes

### From Monolithic Frontend to Component Library

The internationalization architecture has evolved with the @semiont/react-ui factorization:

**Old Architecture** (everything in frontend):
- All translations in `apps/frontend/messages/*.json`
- Direct `next-intl` usage in components
- Tight coupling to Next.js

**New Architecture** (provider pattern):
- Frontend implements `TranslationProvider` interface
- @semiont/react-ui components use provider for translations
- Framework-agnostic components work with any i18n solution

**Key Changes**:
1. Components now call `useTranslations()` from @semiont/react-ui, not `next-intl`
2. Translation logic abstracted behind provider interface
3. Each app can implement i18n differently (next-intl, react-i18next, etc.)
4. Component library remains framework-agnostic

## Resources

- [next-intl Documentation](https://next-intl-docs.vercel.app/)
- [@semiont/react-ui Internationalization](../../packages/react-ui/docs/INTERNATIONALIZATION.md)
- [Translation Key Reference](./TRANSLATION-KEYS.md)