# Semiont React UI - Styles Documentation

Using the styles in an app, the design tokens and the class reference are in
the builder docs: [STYLES.md](../../../docs/builder/react-ui/STYLES.md). This
page is how the styles are written, named and linted inside the package.

## Overview

The Semiont React UI package uses a modular, semantic CSS architecture with zero utility framework dependencies. All styles are organized into logical modules using BEM methodology and CSS custom properties.

## The styling policy

**Plain CSS only.** No Tailwind, no `@apply`, no utility classes, no CSS-in-JS
in this package — a component's appearance comes from `semiont-`-prefixed BEM
classes, data attributes, and custom properties, and nothing else. A stylesheet
built that way drops into any host stack; one built on a utility framework
drags that framework in with it.

Three gates enforce it, so this is a build failure rather than a convention:

- `npm run lint:no-utility-classes` — no utility framework in `packages/react-ui`
- `semiont/invariants` — rejects utility class names and hardcoded colours
- `.stylelintrc.json`'s `selector-class-pattern` — class names must be
  `semiont-*` (plus a short, explicit allowlist for `annotation-*`, CodeMirror,
  and markdown classes)

**Hosts are unconstrained.** The policy binds this package, not the app
consuming it — `apps/browser` uses Tailwind. A host adopts the styles by
importing `@semiont/react-ui/styles`, or takes only the tokens from
`@semiont/react-ui/styles/variables.css`, or bridges through
`@semiont/react-ui/integrations/css-modules` or
`.../integrations/styled-components`.

## Architecture

### CSS Organization Pattern

The package uses **component-level CSS** with source export:

1. **Component CSS files live next to components** (e.g., `PdfAnnotationCanvas.css` next to `PdfAnnotationCanvas.tsx`)
2. **Main stylesheet imports component CSS** via `@import` statements
3. **Package exports source CSS**, not built CSS
4. **Your app's build system processes the CSS** with PostCSS

This pattern provides:
- ✅ Better developer experience (styles co-located with components)
- ✅ No build complexity in react-ui (TypeScript only)
- ✅ Industry-standard approach
- ✅ Framework compatibility (works with Next.js, Vite, etc.)

### Directory Structure

```text
packages/react-ui/src/
├── components/                    # Components with co-located CSS
│   ├── pdf-annotation/
│   │   ├── PdfAnnotationCanvas.tsx
│   │   └── PdfAnnotationCanvas.css    # Component-level CSS
│   ├── branding/Branding.css
│   ├── layout/                        # Header, LeftSidebar, ResizeHandle, SkipLinks
│   ├── modals/                        # modals.css, SearchModal.css
│   ├── navigation/                    # one file per navigation component
│   ├── resource/panels/               # one file per resource panel
│   ├── loading-states/loading.css     # Loading states
│   ├── error-states/errors.css        # Error states
│   └── …                              # Toast, Toolbar, StatusDisplay, annotation entries, …
├── features/auth/auth.css         # Authentication UI
└── styles/
    ├── index.css                  # Main entry point (imports all CSS)
    ├── variables.css              # Design tokens and CSS custom properties
    ├── base/                      # Foundation styles
    │   ├── reset.css              # CSS reset/normalize
    │   └── utilities.css          # Semantic utility classes
    ├── utilities/                 # Accessibility and interaction utilities
    │   ├── focus.css              # Focus management
    │   ├── focus-extended.css     # Extended focus patterns
    │   ├── motion.css             # Animation preferences
    │   ├── motion-overrides.css   # Reduced-motion overrides
    │   ├── contrast.css           # High contrast support
    │   └── semantic-indicators.css # Semantic state indicators
    ├── layout/
    │   └── layout.css             # Page and container layouts
    ├── core/                      # Fundamental UI elements
    │   ├── index.css              # Core imports
    │   ├── buttons.css            # Button system
    │   ├── toggles.css            # Toggle switches
    │   ├── progress.css           # Progress bars
    │   ├── sliders.css            # Range inputs
    │   ├── inputs.css             # Text inputs
    │   ├── checkboxes.css         # Checkboxes
    │   ├── textareas.css          # Multi-line inputs
    │   ├── selects.css            # Dropdowns
    │   ├── forms.css              # Form field wrappers and layout
    │   ├── badges.css             # Section headers and a pulse keyframe; no badge classes
    │   ├── tags.css               # Content tags
    │   └── indicators.css         # Status indicators
    ├── motivations/               # W3C Web Annotation motivations
    │   ├── motivation-reference.css  # Linking (cyan/blue gradient)
    │   ├── motivation-highlight.css  # Highlighting (yellow)
    │   ├── motivation-assessment.css # Assessing (red wavy underline)
    │   ├── motivation-comment.css    # Commenting (dashed outline)
    │   └── motivation-tag.css        # Tagging (orange/amber gradient)
    ├── panels/
    │   ├── history-panel.css      # History panel
    │   └── user-panel.css         # User panel
    ├── features/                  # Feature-specific styles
    │   ├── compose.css            # Resource composition
    │   ├── entity-tags.css        # Entity tag management
    │   ├── recent-docs.css        # Recent documents
    │   ├── resource.css           # Core resource styles
    │   ├── resource-discovery.css # Resource discovery
    │   ├── resource-viewer.css    # Resource viewing/editing
    │   └── schemas.css            # Tag schemas
    └── patterns/                  # Reusable design-system patterns
        ├── panels-base.css        # Base panel styles
        ├── panel-helpers.css      # Annotation-prompt helpers
        └── cards.css              # Cards
```

## Naming Convention

We use BEM (Block Element Modifier) methodology with the `semiont-` prefix:

### Basic Structure

```css
/* Block */
.semiont-component { }

/* Element */
.semiont-component__element { }

/* Modifier */
.semiont-component--modifier { }

/* Element with Modifier */
.semiont-component__element--modifier { }
```

### Examples

```css
/* Panel */
.semiont-panel { }
.semiont-panel__content { }
.semiont-panel__section-title { }
.semiont-panel__section-title--collapsible { }

/* Button */
.semiont-button { }
.semiont-button--primary { }
.semiont-button--danger { }
.semiont-button--large { }
```

## Dark Mode Support

Dark mode is served two ways, and choosing the right one is the whole of it.

**Semantic tokens flip themselves.** `--semiont-text-*`, `--semiont-bg-*`,
`--semiont-border-*`, `--semiont-bg-hover` and `--semiont-focus-ring` are
redefined under `[data-theme="dark"]` in `variables.css`. A rule built from
them is already dark-aware, and **must not** be given a `[data-theme="dark"]`
twin — an override with the same value on both sides is a rule that provably
changes nothing.

```css
/* Both themes, one rule — the token carries the theme. */
.semiont-component {
  background-color: var(--semiont-bg-secondary);
  color: var(--semiont-text-primary);
}
```

**Palette tokens do not flip.** `--semiont-color-primary-500`,
`--semiont-color-gray-300`, `--semiont-color-warning` and the rest are one
fixed hue in both themes, so a rule using them needs a real variant. Accents
step lighter against a dark surface; the status colours have `-light`
companions built for exactly this.

```css
.semiont-progress__fill--error {
  background-color: var(--semiont-color-error);
}

[data-theme="dark"] .semiont-progress__fill--error {
  background-color: var(--semiont-color-error-light);
}
```

`semiont/invariants` enforces this split: it reads which properties
`variables.css` redefines for dark mode and warns only where the colour is
genuinely fixed. Write `[data-theme="dark"]` — **not**
`:root:not([data-theme="light"])`, which the same rule reports as an invalid
theme selector.

## Architectural Principles

### Design Token System

The CSS architecture uses a comprehensive design token system that ensures consistency across all components:

1. **Centralized Variables** - All design decisions (colors, spacing, typography) are defined in `variables.css`
2. **Semantic Tokens** - Variables are named by intent, not appearance (e.g., `--semiont-bg-primary`, not `--white`)
3. **Component Tokens** - Specific tokens for complex components (e.g., panel design tokens)
4. **Cascading Values** - Tokens reference other tokens for maintainability

Example of token cascading:
```css
/* Base token */
--semiont-text-lg: 1.125rem;

/* Component token references base */
--semiont-panel-title-size: var(--semiont-text-lg);

/* Usage in component */
.semiont-panel-header__title {
  font-size: var(--semiont-panel-title-size);
}
```

### Directory Organization

The CSS under `styles/` is organized by conceptual level:

1. **Base** (`base/`) - Reset and semantic utility classes
2. **Core** (`core/`) - Fundamental, atomic UI elements
3. **Patterns** (`patterns/`) - Reusable panel and card patterns
4. **Panels** (`panels/`) - Styles for individual panels
5. **Features** (`features/`) - Feature-specific, non-reusable styles
6. **Motivations** (`motivations/`) - W3C Web Annotation standard styles
7. **Utilities** (`utilities/`) - Accessibility and interaction helpers
8. **Layout** (`layout/`) - Page and container layouts

Composed components (modals, navigation, resource panels, toolbar) carry their CSS beside their `.tsx` under `src/components/`.

### Separation of Concerns

- **Core vs Components**: Core elements are atomic (buttons, toggles), while composed components (modals, navigation) keep their CSS next to their code
- **Patterns vs Panels**: Patterns are shared panel and card structures; a panel's own CSS holds what is specific to it
- **Features vs Components**: Features are page-specific, components are reusable
- **Motivations**: Dedicated styles for W3C Web Annotation standard, kept separate for clarity

## Best Practices

### 1. Use Semantic Classes

Always use semantic classes that describe the component, not its appearance:

```css
/* Good */
.semiont-panel-header__title { }
.semiont-button--primary { }

/* Avoid */
.flex-center { }
.bg-blue { }
```

### 2. Follow BEM Methodology

Keep the hierarchy clear and consistent:

```css
/* Block */
.semiont-document-viewer { }

/* Elements (direct children) */
.semiont-document-viewer__header { }
.semiont-document-viewer__content { }

/* Modifiers (variants) */
.semiont-document-viewer--panel-open { }
```

### 3. Use CSS Variables

Leverage design tokens for consistency:

```css
.semiont-component {
  padding: var(--semiont-spacing-md);
  color: var(--semiont-color-gray-700);
  border-radius: var(--semiont-radius-lg);
}
```

### 4. Support Dark Mode

Reach for a semantic token first — it themes itself and needs no second rule.
Add a `[data-theme="dark"]` variant only when the colour is a fixed palette
hue. See [Dark Mode Support](#dark-mode-support).

```css
/* Preferred: one rule, themed by the token. */
.semiont-component {
  background: var(--semiont-bg-primary);
}

/* Only when the value is a fixed hue: */
.semiont-component__accent {
  background: var(--semiont-color-primary-500);
}

[data-theme="dark"] .semiont-component__accent {
  background: var(--semiont-color-primary-400);
}
```

### 5. Keep Files Focused

Each CSS file should have a single, clear purpose. If a file grows beyond 500 lines, consider splitting it.

## Adding New Styles

When adding new components or features:

1. **Choose the right location**:
   - **Component-level CSS** (preferred for new components):
     - Create `.css` file next to component `.tsx` file
     - Example: `src/components/video-annotation/VideoAnnotationCanvas.css`
   - **Consolidated styles** (existing patterns):
     - Fundamental UI elements → `core/`
     - Shared panel and card patterns → `patterns/`
     - Panel layouts → `panels/`
     - Feature-specific styles → `features/`
     - W3C motivation styles → `motivations/`
     - Layout patterns → `layout/`
     - Accessibility utilities → `utilities/`

2. **For component-level CSS** (preferred pattern):
   ```bash
   # 1. Create CSS file next to component
   src/components/video-annotation/
   ├── VideoAnnotationCanvas.tsx
   └── VideoAnnotationCanvas.css  # New file
   ```

   ```typescript
   // 2. Import CSS in component (type hint only)
   import './VideoAnnotationCanvas.css';
   ```

   ```css
   /* 3. Add import to main stylesheet */
   /* src/styles/index.css */
   @import '../components/video-annotation/VideoAnnotationCanvas.css';
   ```

3. **For consolidated styles** (existing pattern):
   ```css
   /* core/new-element.css or features/new-feature.css */
   /**
    * New Element/Component Styles
    *
    * Description of what this does
    */
   ```

   ```css
   /* Import in appropriate index file */
   /* For core elements, add to core/index.css */
   @import './new-element.css';

   /* For other files, add to styles/index.css in correct section */
   @import './features/new-feature.css';
   ```

4. **Follow naming convention**:
   ```css
   .semiont-new-component { }
   .semiont-new-component__element { }
   .semiont-new-component--modifier { }
   ```

5. **Include dark mode support**:
   ```css
   [data-theme="dark"] .semiont-new-component { }
   ```

6. **Use design tokens**:
   ```css
   .semiont-new-component {
     padding: var(--semiont-spacing-md);
     color: var(--semiont-text-primary);
     background: var(--semiont-bg-primary);
   }
   ```

**Important:** Whether using component-level CSS or consolidated styles, always add the `@import` to `src/styles/index.css` so the CSS gets included in the bundle.

## Performance Considerations

1. **Modular imports**: Only import what you need
2. **CSS custom properties**: Use variables for repeated values
3. **Avoid deep nesting**: Keep selectors shallow for performance
4. **Minimize specificity**: Use single class selectors when possible
5. **Leverage cascading**: Let CSS inheritance work for you

## Debugging

### Common Issues

1. **Styles not applying**:
   - Check that the CSS file is imported in `index.css`
   - Verify the class name matches exactly (case-sensitive)
   - Check specificity conflicts

2. **Dark mode not working**:
   - Ensure `data-theme="dark"` is set on a parent element
   - Check that dark mode styles are defined

3. **Layout issues**:
   - Verify box-sizing is set (handled by reset.css)
   - Check for conflicting margin/padding

### Development Tips

1. Use browser DevTools to inspect computed styles
2. Toggle `data-theme` attribute to test dark mode
3. Check the cascade order in index.css
4. Use CSS source maps for debugging

## Contributing

When contributing styles:

1. Follow the established patterns
2. Maintain consistency with existing code
3. Document complex styles with comments
4. Test in both light and dark modes
5. Ensure responsive behavior
6. Keep accessibility in mind (contrast, focus states)

## File Size Guidelines

To maintain a manageable codebase:

- **Component files**: ~200-400 lines
- **Feature files**: ~300-500 lines
- **Maximum file size**: ~500 lines (split if larger)

## CSS Quality & Linting

The package uses custom Stylelint rules to enforce code quality and accessibility standards.

### Running the Linter

```bash
npm run lint:css
```

### Custom Linter Rules

#### semiont/invariants
Enforces design system consistency:
- **No hardcoded colors** - Must use CSS variables instead of hex values
- **Dark variant where the colour is fixed** - A `semiont-` rule that sets a colour property from a palette token or a literal needs a `[data-theme="dark"]` variant; one built only from semantic tokens needs none (see [Dark Mode Support](#dark-mode-support))
- **Naming** - No utility class names, and react-ui classes carry the `semiont-` prefix (with the same short allowlist as `selector-class-pattern`)

#### semiont/accessibility
Ensures WCAG 2.1 AA compliance:
- **Reduced motion support** - Animations must respect `prefers-reduced-motion`
- **Color contrast** - Validates contrast ratios (4.5:1 for text, 3:1 for large text)
- **Focus indicators** - Interactive elements must have visible focus states
- **Semantic indicators** - Status states need non-color cues (icons, patterns)

#### semiont/theme-selectors
Validates dark mode patterns:
- Enforces `[data-theme="dark"]` selector pattern
- Prevents incorrect theme implementation

### Global Accessibility Support

The package includes comprehensive global accessibility utilities that apply to all components:

**Reduced Motion** (`src/styles/utilities/motion-overrides.css`):
- Global `@media (prefers-reduced-motion: reduce)` rule
- Disables all animations and transitions automatically
- Components inherit this support - no per-component overrides needed
- Linter recognizes global support for `src/styles/`, `src/components/`, `src/features/`

**High Contrast** (`src/styles/utilities/contrast.css`):
- Supports `prefers-contrast: high` media query
- Enhances borders, outlines, and focus indicators

**Semantic Indicators** (`src/styles/utilities/semantic-indicators.css`):
- Icons and patterns for status states
- Ensures accessibility beyond color alone

### Linting Best Practices

1. **Always use CSS variables for colors:**
   ```css
   /* Good */
   color: var(--semiont-color-blue-600);

   /* Bad */
   color: #2563eb;
   ```

2. **Give a fixed palette colour a dark mode variant:**
   ```css
   .semiont-component {
     background-color: var(--semiont-color-gray-100);
   }

   [data-theme="dark"] .semiont-component {
     background-color: var(--semiont-color-gray-800);
   }
   ```

3. **Animations inherit global reduced-motion support:**
   - Components in `src/components/` and `src/features/` automatically inherit global motion overrides
   - No need to add per-component `@media (prefers-reduced-motion: reduce)` rules
   - Global overrides in `motion-overrides.css` handle all animations/transitions

4. **Use semantic class names with proper focus states:**
   ```css
   .semiont-button {
     /* Base styles */
   }

   .semiont-button:focus-visible {
     outline: 2px solid var(--semiont-color-blue-500);
     outline-offset: 2px;
   }
   ```

### Fixing Linter Errors

**Hardcoded color error:**
```text
Hardcoded color "#3b82f6" detected. Use CSS variables instead.
```
Fix: Replace hex color with appropriate CSS variable from `variables.css` (here `var(--semiont-color-blue-500)`)

**Missing dark mode variant:**
```text
Missing dark theme variant for ".semiont-component". Add [data-theme="dark"] variant.
```
Fix: Add `[data-theme="dark"] .semiont-component { }` selector

**Animation without reduced motion:**
```text
Animation/transition "transition" should respect prefers-reduced-motion. Add @media (prefers-reduced-motion: reduce) variant.
```
Note: This warning should not appear for files in `src/components/` or `src/features/` as they inherit global motion overrides. If you see this, verify the file is in the correct location.

## Resources

- [BEM Methodology](http://getbem.com/)
- [CSS Custom Properties](https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties)
- [Dark Mode Best Practices](https://web.dev/prefers-color-scheme/)
- [CSS Performance](https://developer.mozilla.org/en-US/docs/Learn/Performance/CSS)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [Stylelint](https://stylelint.io/)
