# Internationalization (i18n) Guide

## Overview

The Semiont frontend uses a hybrid internationalization approach that combines:
- **Frontend-specific translations** managed by Next.js and `next-intl`
- **Component translations** provided by `@semiont/react-ui` with built-in English and Spanish
- **Dynamic loading** for optimal bundle size

## Architecture

### Translation Sources

1. **Frontend Messages** (`apps/frontend/messages/*.json`)
   - Page-specific content
   - Frontend-only features
   - Application routes and metadata

2. **React-UI Translations** (`packages/react-ui/translations/*.json`)
   - Component UI strings
   - Common UI elements (buttons, labels, etc.)
   - Shared across all Semiont applications

### Translation Manager

The frontend uses a custom `useTranslationManager` hook that:
- Bridges `next-intl` with `@semiont/react-ui` translations
- Merges frontend and component translations
- Handles parameter interpolation
- Provides a unified interface

```typescript
// apps/frontend/src/hooks/useTranslationManager.ts
export function useTranslationManager(): TranslationManager {
  const messages = useMessages();
  const locale = useLocale();

  return useMemo(() => ({
    t: (namespace: string, key: string, params?: Record<string, any>): string => {
      // Check frontend messages first
      // Then check react-ui translations
      // Handle parameter interpolation
    }
  }), [messages, locale]);
}
```

## Adding a New Language

### Step 1: Add Frontend Translations

1. Create a new message file:
   ```bash
   cp messages/en.json messages/fr.json
   ```

2. Translate frontend-specific keys in `messages/fr.json`

3. Add locale to Next.js config:
   ```typescript
   // src/i18n/config.ts
   export const locales = ['en', 'es', 'fr'] as const;
   ```

### Step 2: Add Component Translations (react-ui)

1. Create translation file:
   ```bash
   cd packages/react-ui/translations
   cp en.json fr.json
   ```

2. Translate component UI strings in `fr.json`

3. Update the available locales:
   ```typescript
   // packages/react-ui/src/contexts/TranslationContext.tsx
   export const AVAILABLE_LOCALES = ['en', 'es', 'fr'] as const;
   ```

### Step 3: Update Translation Manager

1. Import the new translations:
   ```typescript
   // apps/frontend/src/hooks/useTranslationManager.ts
   import frReactUI from '../../../../packages/react-ui/translations/fr.json';

   const reactUITranslations: Record<string, any> = {
     en: enReactUI,
     es: esReactUI,
     fr: frReactUI,  // Add this
   };
   ```

### Step 4: Add Locale Metadata

1. Update middleware to support the new locale:
   ```typescript
   // apps/frontend/src/middleware.ts
   const locales = ['en', 'es', 'fr'];
   ```

2. Add locale display names:
   ```typescript
   // apps/frontend/src/lib/locales.ts
   export const localeNames = {
     en: 'English',
     es: 'Español',
     fr: 'Français',
   };
   ```

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

When migrating from the old system:

1. Component translations moved from `apps/frontend/messages/*.json` to `packages/react-ui/translations/*.json`
2. Frontend now uses `useTranslationManager` hook instead of direct `next-intl`
3. Dynamic loading reduces bundle size for non-English locales

## Resources

- [next-intl Documentation](https://next-intl-docs.vercel.app/)
- [@semiont/react-ui Internationalization](../../packages/react-ui/docs/INTERNATIONALIZATION.md)
- [Translation Key Reference](./TRANSLATION-KEYS.md)