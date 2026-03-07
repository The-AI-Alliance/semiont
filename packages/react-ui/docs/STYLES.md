# Semiont React UI - Styles Documentation

## Overview

The Semiont React UI package uses a modular, semantic CSS architecture with zero utility framework dependencies. All styles are organized into logical modules using BEM methodology and CSS custom properties.

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

### No Configuration Needed

- ✅ Next.js: Works out of the box
- ✅ Vite: Works out of the box
- ✅ Create React App: Works out of the box
- ✅ Remix: Works out of the box

The package exports **source CSS files**, not built CSS, so your framework's build system processes them.

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

```
packages/react-ui/src/
├── components/               # Components with co-located CSS
│   └── pdf-annotation/
│       ├── PdfAnnotationCanvas.tsx
│       └── PdfAnnotationCanvas.css  # Component-level CSS
├── styles/
│   ├── index.css             # Main entry point (imports all CSS)
│   ├── variables.css          # Design tokens and CSS custom properties
├── base/                      # Foundation styles
│   ├── reset.css             # CSS reset/normalize
│   └── utilities.css         # Semantic utility classes
├── utilities/                 # Accessibility and interaction utilities
│   ├── focus.css             # Focus management
│   ├── focus-extended.css    # Extended focus patterns
│   ├── motion.css            # Animation preferences
│   ├── motion-overrides.css  # Motion overrides
│   ├── contrast.css          # High contrast support
│   └── semantic-indicators.css # Semantic state indicators
├── layout/                    # Layout patterns
│   └── layout.css            # Page and container layouts
├── core/                      # Fundamental UI elements
│   ├── index.css             # Core imports
│   ├── buttons.css           # Button system
│   ├── toggles.css           # Toggle switches
│   ├── progress.css          # Progress bars
│   ├── sliders.css           # Range inputs
│   ├── badges.css            # Status badges
│   ├── tags.css              # Content tags
│   └── indicators.css        # Status indicators
├── components/                # Complex composed components
│   ├── forms.css             # Form controls
│   ├── auth.css              # Authentication UI
│   ├── cards.css             # Card components
│   ├── modals.css            # Modal dialogs
│   ├── panels-base.css       # Base panel styles
│   ├── panel-sections.css    # Panel section patterns
│   ├── references.css        # Reference components
│   ├── status-display.css    # Status displays
│   ├── tables.css            # Data tables
│   ├── toast.css             # Toast notifications
│   ├── toolbar.css           # Toolbar components
│   ├── branding.css          # Branding elements
│   ├── sidebar-navigation.css # Sidebar navigation
│   ├── collapsible-resource-navigation.css # Resource nav
│   ├── annotations.css       # Annotation components
│   ├── annotation-entries.css # Annotation entries
│   └── skip-links.css        # Accessibility skip links
├── motivations/               # W3C Web Annotation motivations
│   ├── motivation-reference.css  # Linking (blue gradient)
│   ├── motivation-highlight.css  # Highlighting (yellow)
│   ├── motivation-assessment.css # Assessing (red underline)
│   ├── motivation-comment.css    # Commenting (dashed outline)
│   └── motivation-tag.css        # Tagging (orange gradient)
├── panels/                    # Panel layouts
│   ├── collaboration-panel.css   # Collaboration panel
│   ├── jsonld-panel.css         # JSON-LD panel
│   ├── references-panel.css     # References panel
│   ├── settings-panel.css       # Settings panel
│   ├── unified-annotations-panel.css # Unified annotations
│   ├── resource-info-panel.css  # Resource info
│   ├── tagging-panel.css        # Tagging panel
│   ├── highlight-panel.css      # Highlight panel
│   ├── comments-panel.css       # Comments panel
│   ├── assessment-panel.css     # Assessment panel
│   ├── statistics-panel.css     # Statistics panel
│   └── history-panel.css        # History panel
├── features/                  # Feature-specific styles
│   ├── admin.css             # Admin dashboard
│   ├── compose.css           # Resource composition
│   ├── devops.css            # DevOps features
│   ├── entity-tags.css       # Entity tag management
│   ├── recent-docs.css       # Recent documents
│   ├── resource.css          # Core resource styles
│   ├── resource-discovery.css # Resource discovery
│   ├── resource-viewer.css   # Resource viewing/editing
│   ├── schemas.css           # Tag schemas
│   ├── static-pages.css      # Static pages
│   └── welcome.css           # Welcome/onboarding
└── patterns/                  # Reusable patterns
    ├── errors.css            # Error states
    └── loading.css           # Loading states
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
/* Card component */
.semiont-card { }
.semiont-card__header { }
.semiont-card__title { }
.semiont-card__content { }
.semiont-card--large { }

/* Button component */
.semiont-button { }
.semiont-button--primary { }
.semiont-button--danger { }
.semiont-button--disabled { }
```

## Dark Mode Support

All components support dark mode using the `data-theme` attribute:

```css
/* Light mode (default) */
.semiont-component {
  background-color: var(--semiont-color-white);
  color: var(--semiont-color-gray-900);
}

/* Dark mode */
[data-theme="dark"] .semiont-component,
:root:not([data-theme="light"]) .semiont-component {
  background-color: var(--semiont-color-gray-900);
  color: var(--semiont-color-white);
}
```

## CSS Variables

Design tokens are defined in `variables.css`:

### Color Palette

```css
--semiont-color-primary-500: #3b82f6;
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
--semiont-panel-gap: 1.5rem;
--semiont-panel-border-radius: 0.5rem;
--semiont-panel-title-size: var(--semiont-text-lg);
--semiont-panel-title-weight: 600;
--semiont-panel-header-margin-bottom: 1rem;
--semiont-panel-section-gap: 1.5rem;
--semiont-panel-field-gap: 0.5rem;
--semiont-panel-icon-size: 1.25rem;
```

### Border Radius

```css
--semiont-radius-sm: 0.25rem;
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
- `semiont-button--primary` - Primary action
- `semiont-button--secondary` - Secondary action
- `semiont-button--tertiary` - Tertiary action
- `semiont-button--danger` - Destructive action
- `semiont-button--ghost` - Minimal style
- `semiont-button--small` - Smaller size
- `semiont-button--large` - Larger size

### Toggle Switches
Located in `core/toggles.css`, for binary on/off controls:

```jsx
<label className="semiont-toggle">
  <input type="checkbox" className="semiont-toggle__input" />
  <span className="semiont-toggle__slider"></span>
</label>
```

### Progress Bars
Located in `core/progress.css`, for showing completion status:

```jsx
<div className="semiont-progress">
  <div className="semiont-progress__bar" style={{width: '60%'}}></div>
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

### Badges
Located in `core/badges.css`, for status indicators:

```jsx
<span className="semiont-badge semiont-badge--admin">Admin</span>
<span className="semiont-badge semiont-badge--active">Active</span>
```

### Status Indicators
Located in `core/indicators.css`, for online/offline states:

```jsx
<span className="semiont-indicator semiont-indicator--online"></span>
<span className="semiont-indicator semiont-indicator--offline"></span>
```

## W3C Web Annotation Motivations

The `motivations/` directory contains styles for the five W3C Web Annotation standard motivations:

### Linking (References)
Located in `motivation-reference.css`:
- Visual: Blue to cyan gradient background
- Use: For annotations that link to other resources

```css
.semiont-motivation--linking {
  background: linear-gradient(135deg,
    var(--semiont-color-blue-100) 0%,
    var(--semiont-color-cyan-50) 100%);
}
```

### Highlighting
Located in `motivation-highlight.css`:
- Visual: Yellow background
- Use: For text highlighting and emphasis

```css
.semiont-motivation--highlighting {
  background: var(--semiont-color-yellow-100);
}
```

### Assessing
Located in `motivation-assessment.css`:
- Visual: Red wavy underline
- Use: For quality assessments and evaluations

```css
.semiont-motivation--assessing {
  text-decoration: underline wavy var(--semiont-color-red-500);
}
```

### Commenting
Located in `motivation-comment.css`:
- Visual: Black (light) or white (dark) dashed outline
- Use: For discussion and commentary

```css
.semiont-motivation--commenting {
  border: 2px dashed var(--semiont-color-black);
  border-radius: var(--semiont-radius-md);
}
```

### Tagging
Located in `motivation-tag.css`:
- Visual: Orange to amber gradient background
- Use: For categorization and classification

```css
.semiont-motivation--tagging {
  background: linear-gradient(135deg,
    var(--semiont-color-orange-100) 0%,
    var(--semiont-color-amber-50) 100%);
}
```

### Cards

```jsx
<div className="semiont-card">
  <div className="semiont-card__header">
    <h3 className="semiont-card__title">Card Title</h3>
  </div>
  <div className="semiont-card__content">
    Content goes here
  </div>
</div>
```

### Forms

```jsx
<div className="semiont-form">
  <div className="semiont-form__field">
    <label className="semiont-form__label">Label</label>
    <input className="semiont-form__input" />
    <p className="semiont-form__helper-text">Helper text</p>
  </div>
</div>
```

### Panels

```jsx
<div className="semiont-panel">
  <div className="semiont-panel__header">
    <h3 className="semiont-panel__title">Panel Title</h3>
  </div>
  <div className="semiont-panel__content">
    Panel content
  </div>
</div>
```

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
.semiont-panel__title {
  font-size: var(--semiont-panel-title-size);
}
```

### Directory Organization

The CSS is organized by conceptual level:

1. **Core** (`core/`) - Fundamental, atomic UI elements
2. **Components** (`components/`) - Composed, complex components
3. **Panels** (`panels/`) - Layout containers and panel structures
4. **Features** (`features/`) - Feature-specific, non-reusable styles
5. **Motivations** (`motivations/`) - W3C Web Annotation standard styles
6. **Utilities** (`utilities/`) - Accessibility and interaction helpers
7. **Patterns** (`patterns/`) - Reusable state patterns

### Separation of Concerns

- **Core vs Components**: Core elements are atomic (buttons, toggles), while components are composed (forms, modals)
- **Components vs Panels**: Components are UI pieces, panels are layout containers
- **Features vs Components**: Features are page-specific, components are reusable
- **Motivations**: Dedicated styles for W3C Web Annotation standard, kept separate for clarity

## Best Practices

### 1. Use Semantic Classes

Always use semantic classes that describe the component, not its appearance:

```css
/* Good */
.semiont-card__header { }
.semiont-button--primary { }

/* Avoid */
.flex-center { }
.bg-blue { }
```

### 2. Follow BEM Methodology

Keep the hierarchy clear and consistent:

```css
/* Block */
.semiont-resource-viewer { }

/* Elements (direct children) */
.semiont-resource-viewer__header { }
.semiont-resource-viewer__content { }

/* Modifiers (variants) */
.semiont-resource-viewer--compact { }
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

Always provide dark mode styles:

```css
.semiont-component {
  background: var(--semiont-color-white);
}

[data-theme="dark"] .semiont-component,
:root:not([data-theme="light"]) .semiont-component {
  background: var(--semiont-color-gray-900);
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
     - Complex composed components → `components/`
     - Panel layouts → `panels/`
     - Feature-specific styles → `features/`
     - W3C motivation styles → `motivations/`
     - Layout patterns → `layout/`
     - State patterns → `patterns/`
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
   /* core/new-element.css or components/new-component.css */
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
   @import './components/new-component.css';
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
- **Dark mode required** - All components must have `[data-theme="dark"]` variants
- **Design tokens** - Enforces usage of predefined CSS custom properties

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

2. **Always provide dark mode variants:**
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
```bash
✖ Hardcoded color #3b82f6. Use var(--semiont-color-blue-500)
```
Fix: Replace hex color with appropriate CSS variable from `variables.css`

**Missing dark mode variant:**
```bash
⚠ Missing dark theme variant for ".semiont-component"
```
Fix: Add `[data-theme="dark"] .semiont-component { }` selector

**Animation without reduced motion:**
```bash
⚠ Animation "transition" should respect prefers-reduced-motion
```
Note: This warning should not appear for files in `src/components/` or `src/features/` as they inherit global motion overrides. If you see this, verify the file is in the correct location.

## Resources

- [BEM Methodology](http://getbem.com/)
- [CSS Custom Properties](https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties)
- [Dark Mode Best Practices](https://web.dev/prefers-color-scheme/)
- [CSS Performance](https://developer.mozilla.org/en-US/docs/Learn/Performance/CSS)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [Stylelint](https://stylelint.io/)