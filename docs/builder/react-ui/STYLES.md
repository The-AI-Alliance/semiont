# Styles

How to use `@semiont/react-ui`'s styles in your own app: importing them, the
design tokens, and the classes the components are built from.

Your app's own styling is unconstrained. Take all the styles with
`@semiont/react-ui/styles`, only the tokens with
`@semiont/react-ui/styles/variables.css`, or bridge through
`@semiont/react-ui/integrations/css-modules` or
`@semiont/react-ui/integrations/styled-components`.

Dark mode is `data-theme="dark"` on a parent element. The semantic tokens
(`--semiont-text-*`, `--semiont-bg-*`, `--semiont-border-*`) change with it;
the palette tokens (`--semiont-color-*`) are one fixed hue in both themes.

How the styles are written, named and linted inside the package is in its
[STYLES.md](../../../packages/react-ui/docs/STYLES.md).

## Using the Styles in Your App

### Import Styles

Add this to your app's main CSS file:

```css
/* app/globals.css (Next.js) or src/index.css (Vite/CRA) */
@import '@semiont/react-ui/styles';
```

### Requirements

Your build system must support:
- **PostCSS** with the **`postcss-import`** plugin
- This is standard in Next.js, Vite, and most modern React frameworks

### What Happens

1. Your build system resolves `@import '@semiont/react-ui/styles'` to `node_modules/@semiont/react-ui/src/styles/index.css`
2. PostCSS processes all nested `@import` statements (including component CSS)
3. All CSS is bundled into a single optimized file

The package exports **source CSS files**, not built CSS, so your framework's build system processes them. Vite does it with no configuration: the Semiont Browser's own stylesheet starts with this import.

### Debugging

Because your bundler processes the source files, its CSS source maps lead to them: a rule in the browser's developer tools opens at its file under `node_modules/@semiont/react-ui/src/styles/`. In Vite, `css: { devSourcemap: true }` turns them on for development.

```
src/styles/
├── index.css       # the entry point, which imports the rest
├── variables.css   # design tokens
├── base/           # reset and base utilities
├── core/           # buttons, forms, badges, indicators
├── motivations/    # one stylesheet per annotation motivation
├── panels/         # the panels
├── patterns/       # cards and what panels share
├── features/       # feature-specific styles
├── layout/         # layout
└── utilities/      # accessibility utilities
```

## CSS Variables

Design tokens are defined in `variables.css`:

### Color Palette

```css
--semiont-color-primary-500: #0080ff;
--semiont-color-gray-50: #f9fafb;
--semiont-color-gray-900: #111827;
--semiont-color-white: #ffffff;
--semiont-color-black: #000000;
/* Full palettes for primary, gray, red, yellow, green, blue, etc. */
```

### Typography

```css
--semiont-font-sans: /* system font stack */;
--semiont-font-mono: /* monospace font stack */;
--semiont-text-xs: 0.75rem;
--semiont-text-sm: 0.875rem;
--semiont-text-base: 1rem;
--semiont-text-lg: 1.125rem;
/* ... and more */
```

### Spacing

```css
--semiont-spacing-xs: 0.25rem;
--semiont-spacing-sm: 0.5rem;
--semiont-spacing-md: 1rem;
--semiont-spacing-lg: 1.5rem;
/* ... and more */
```

### Panel Design Tokens

```css
/* Centralized panel styling for consistency */
--semiont-panel-padding: 1rem;
--semiont-panel-gap: 1rem;
--semiont-panel-border-radius: var(--semiont-radius-lg);
--semiont-panel-title-size: var(--semiont-text-lg);
--semiont-panel-title-weight: var(--semiont-font-semibold);
--semiont-panel-header-margin-bottom: 0.75rem;
--semiont-panel-section-gap: 1.5rem;
--semiont-panel-field-gap: 0.5rem;
--semiont-panel-icon-size: 1.125rem;
```

### Border Radius

```css
--semiont-radius-sm: 0.125rem;
--semiont-radius-md: 0.375rem;
--semiont-radius-lg: 0.5rem;
--semiont-radius-full: 9999px;
```

## Core UI Elements

The `core/` directory contains fundamental UI elements that are reused throughout the application:

### Buttons
Located in `core/buttons.css`, provides a comprehensive button system:

```jsx
<button className="semiont-button semiont-button--primary">
  Primary Button
</button>
```

Available modifiers:
- `semiont-button--primary` - Primary action (cyan/blue gradient)
- `semiont-button--secondary` - Secondary action
- `semiont-button--tertiary` - Tertiary action
- `semiont-button--danger` - Destructive action
- `semiont-button--warning` - Amber; highlight actions
- `semiont-button--large` - Full width, larger padding
- `semiont-button--scale` - Grows on hover

`buttonStyles` (exported from `@semiont/react-ui`) holds these combinations as ready-made class strings. The `Button` component styles itself through data attributes instead: `data-variant` (`primary`, `secondary`, `tertiary`, `danger`, `warning`, `ghost`) and `data-size` (`xs` through `xl`) on `.semiont-button`.

### Toggle Switches
Located in `core/toggles.css`, for binary on/off controls:

```jsx
<label className="semiont-toggle-label">
  <span className="semiont-toggle-label__text">Line numbers</span>
  <button
    type="button"
    role="switch"
    aria-checked={isOn}
    className={`semiont-toggle ${isOn ? 'semiont-toggle--active' : ''}`}
  >
    <span className={`semiont-toggle__slider ${isOn ? 'semiont-toggle__slider--active' : ''}`} />
  </button>
</label>
```

### Progress Bars
Located in `core/progress.css`, for showing completion status:

```jsx
<div className="semiont-progress">
  <div className="semiont-progress__fill" style={{width: '60%'}}></div>
</div>
```

### Range Sliders
Located in `core/sliders.css`, for numeric range inputs:

```jsx
<input type="range" className="semiont-slider" min="0" max="100" />
```

### Tags
Located in `core/tags.css`, for content categorization:

```jsx
<span className="semiont-tag">Category</span>
<span className="semiont-tag semiont-tag--secondary">Secondary Tag</span>
```

## W3C Web Annotation Motivations

The `motivations/` directory contains styles for the five W3C Web Annotation standard motivations. Each file defines its `--semiont-motivation-<type>-*` custom properties on `:root`, styles inline annotations through an `annotation-<type>` class, and styles that motivation's panel entries (`.semiont-annotation-entry[data-type="<type>"]`). The class an annotation renders with comes from its entry in `ANNOTATORS` (`src/lib/annotation-registry.ts`).

### Linking (References)
Located in `motivation-reference.css`:
- Visual: Cyan to blue gradient background; dashed outline in dark mode
- Use: For annotations that link to other resources

```css
.annotation-reference {
  background: var(--semiont-motivation-reference-bg);   /* cyan-200 → blue-200 */
  color: var(--semiont-motivation-reference-text);
}
```

### Highlighting
Located in `motivation-highlight.css`:
- Visual: Yellow background; dashed outline in dark mode
- Use: For text highlighting and emphasis

```css
.annotation-highlight {
  background: var(--semiont-motivation-highlight-bg);   /* yellow-200 */
  color: var(--semiont-motivation-highlight-text);
}
```

### Assessing
Located in `motivation-assessment.css`:
- Visual: Red wavy underline
- Use: For quality assessments and evaluations

```css
.annotation-assessment {
  text-decoration: underline wavy;
  text-decoration-color: var(--semiont-motivation-assessment-primary);   /* red-500 */
}
```

### Commenting
Located in `motivation-comment.css`:
- Visual: Dark (light theme) or light (dark theme) dashed outline
- Use: For discussion and commentary

```css
.annotation-comment {
  outline: 2px dashed var(--semiont-motivation-comment-outline);   /* gray-900 */
  outline-offset: 1px;
}
```

### Tagging
Located in `motivation-tag.css`:
- Visual: Orange to amber gradient background; dashed outline in dark mode
- Use: For categorization and classification

```css
.annotation-tag {
  background: var(--semiont-motivation-tag-bg);   /* orange-200 → amber-200 */
  color: var(--semiont-motivation-tag-text);
}
```

## Patterns

### Cards
Located in `patterns/cards.css`:

```jsx
<div className="semiont-card">
  <h3>Card Title</h3>
  <p>Content goes here</p>
</div>
```

### Forms
Located in `core/forms.css` and `core/inputs.css`:

```jsx
<div className="semiont-form">
  <div className="semiont-form__field">
    <label htmlFor="title" className="semiont-form__label">Label</label>
    <input id="title" className="semiont-input" />
    <p className="semiont-form__help">Helper text</p>
  </div>
</div>
```

### Panels
Located in `patterns/panels-base.css`:

```jsx
<div className="semiont-panel">
  <div className="semiont-panel-header">
    <h2 className="semiont-panel-header__title">Panel Title</h2>
  </div>
  <div className="semiont-panel__content">
    Panel content
  </div>
</div>
```
