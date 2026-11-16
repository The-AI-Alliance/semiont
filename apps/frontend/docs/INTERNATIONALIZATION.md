# Internationalization (i18n) Guide

**Last Updated**: 2026-03-29

## Overview

The frontend uses **i18next** + **react-i18next** for internationalization.

- **Translation files**: Merged from two sources before every build/test/dev run
- **Locale routing**: React Router v7 with `/:locale/*` prefix
- **Dynamic loading**: Non-English locales loaded on-demand via `i18next-http-backend`
- **Interpolation format**: `{{variable}}` (standard i18next)

## Architecture

```
packages/react-ui/translations/{locale}.json   ← component-level strings
       +
apps/frontend/messages-source/{locale}.json   ← app-level strings
       │
       │  scripts/merge-translations.js
       │  deepMerge(reactUI, frontend)  — frontend wins on collision
       ▼
apps/frontend/messages/{locale}.json           ← read by vitest mock at test time
apps/frontend/public/messages/{locale}.json    ← served at /messages/{locale}.json at runtime
```

The `messages/` and `public/messages/` directories are **generated** — never edit them directly. Edit the source files instead.

## i18next Configuration

`src/i18n/config.ts` initialises i18next with `i18next-http-backend`:

```typescript
i18n
  .use(HttpBackend)
  .use(initReactI18next)
  .init({
    ns: ['translation'],
    defaultNS: 'translation',
    fallbackLng: 'en',
    backend: {
      loadPath: '/messages/{{lng}}.json',
    },
    interpolation: { escapeValue: false },
  });
```

## Using Translations in Components

The namespace-binding pattern keeps call sites clean:

```typescript
import { useTranslation } from 'react-i18next';

export function MyComponent() {
  const { t: _t } = useTranslation();
  // Bind to namespace so call sites just use t('key')
  const t = (k: string, p?: Record<string, unknown>) =>
    _t(`MyNamespace.${k}`, p as any) as string;

  return <h1>{t('title')}</h1>;
}
```

Translation file (`messages-source/en.json`):
```json
{
  "MyNamespace": {
    "title": "Hello World",
    "greeting": "Hello, {{name}}!"
  }
}
```

## Translation File Organization

**Source files (edit these):**
- `apps/frontend/messages-source/{locale}.json` — app-specific keys (Admin, CookiePreferences, UserPanel, etc.)
- `packages/react-ui/translations/{locale}.json` — react-ui component keys (BrowseView, ResourceViewer, etc.)

**Generated files (do not edit):**
- `apps/frontend/messages/{locale}.json`
- `apps/frontend/public/messages/{locale}.json`

## Adding a New Language

1. Add translation file for the frontend:
   ```bash
   cp apps/frontend/messages-source/en.json apps/frontend/messages-source/fr.json
   # Translate all values in fr.json
   ```

2. Add react-ui translations if needed:
   ```bash
   cp packages/react-ui/translations/en.json packages/react-ui/translations/fr.json
   # Translate all values in fr.json
   ```

3. Add locale to config:
   ```typescript
   // src/i18n/config.ts
   export const SUPPORTED_LOCALES = [..., 'fr'] as const;
   ```

4. Run the merge:
   ```bash
   node apps/frontend/scripts/merge-translations.js
   ```

## Parameter Interpolation

Use double-brace syntax (standard i18next):

```json
{
  "greeting": "Hello, {{name}}!",
  "count": "{{count}} items found"
}
```

```typescript
t('greeting', { name: 'Alice' })  // "Hello, Alice!"
t('count', { count: 5 })          // "5 items found"
```

## Locale Routing

Locale is part of the URL path: `/:locale/*` (e.g., `/en/know`, `/es/admin`).

`src/i18n/routing.tsx` exports React Router wrappers: `Link`, `useRouter`, `usePathname`, `useLocale` — import from `@/i18n/routing`, not directly from react-router-dom.

`LocaleGuard` in `App.tsx` validates the `:locale` param and calls `i18n.changeLanguage()`.

## Testing Translations

The global vitest mock (`vitest.setup.ts`) reads `messages/en.json` at test startup and provides a real `t()` function that resolves `Namespace.key` lookups and performs `{{param}}` substitution.

## Common Issues

### Key shows as `Namespace.key`
The namespace doesn't exist in the translation file, or the merge hasn't been run. Run `node scripts/merge-translations.js`.

### `{{param}}` not replaced
Check that you're passing params: `t('key', { param: value })`.

### Changes to translation files not reflected in tests
The test mock reads `messages/en.json` which is generated. Run `npm test` (which triggers `pretest` → merge) or run `node scripts/merge-translations.js` manually first.

## Resources

- [i18next Documentation](https://www.i18next.com/)
- [react-i18next Documentation](https://react.i18next.com/)
- [@semiont/react-ui documentation](../../../packages/react-ui/README.md)
