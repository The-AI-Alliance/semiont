# Semiont React UI - Styles Documentation

## Overview

The Semiont React UI package uses a modular, semantic CSS architecture with zero utility framework dependencies. All styles are organized into logical modules using BEM methodology and CSS custom properties.

## Architecture

### Directory Structure

```
packages/react-ui/src/styles/
├── index.css                 # Main entry point
├── variables.css              # Design tokens and CSS custom properties
├── base/                      # Foundation styles
│   ├── reset.css             # CSS reset/normalize
│   └── utilities.css         # Semantic utility classes
├── layout/                    # Layout patterns
│   └── layout.css            # Page and container layouts
├── components/                # Core component styles
│   ├── buttons.css           # Button system
│   ├── cards.css             # Card components
│   ├── modals.css            # Modal dialogs
│   ├── panels.css            # Panel components
│   ├── references.css        # Reference panels
│   ├── status-display.css    # Status indicators
│   ├── tables.css            # Data tables
│   ├── toast.css             # Toast notifications
│   ├── toolbar.css           # Toolbar components
│   └── branding.css          # Branding elements
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
/* ... and more */
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

### Border Radius

```css
--semiont-radius-sm: 0.25rem;
--semiont-radius-md: 0.375rem;
--semiont-radius-lg: 0.5rem;
--semiont-radius-full: 9999px;
```

## Component Styles Guide

### Buttons

```jsx
<button className="semiont-button semiont-button--primary">
  Primary Button
</button>
```

Available modifiers:
- `semiont-button--primary`
- `semiont-button--secondary`
- `semiont-button--tertiary`
- `semiont-button--danger`
- `semiont-button--ghost`
- `semiont-button--small`
- `semiont-button--large`

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
   - Core reusable components → `components/`
   - Feature-specific styles → `features/`
   - Layout patterns → `layout/`
   - State patterns → `patterns/`

2. **Create a new file** if the component is substantial:
   ```css
   /* components/new-component.css */
   /**
    * New Component Styles
    *
    * Description of what this component does
    */
   ```

3. **Import in index.css**:
   ```css
   /* Add to appropriate section */
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

## Resources

- [BEM Methodology](http://getbem.com/)
- [CSS Custom Properties](https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties)
- [Dark Mode Best Practices](https://web.dev/prefers-color-scheme/)
- [CSS Performance](https://developer.mozilla.org/en-US/docs/Learn/Performance/CSS)