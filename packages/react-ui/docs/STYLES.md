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
   - Fundamental UI elements → `core/`
   - Complex composed components → `components/`
   - Panel layouts → `panels/`
   - Feature-specific styles → `features/`
   - W3C motivation styles → `motivations/`
   - Layout patterns → `layout/`
   - State patterns → `patterns/`
   - Accessibility utilities → `utilities/`

2. **Determine if it's core or component**:
   - **Core**: Atomic, fundamental elements (button, toggle, slider)
   - **Component**: Composed of multiple elements (form, modal, card)
   - **Panel**: Layout container for content sections

3. **Create a new file** if the component is substantial:
   ```css
   /* core/new-element.css or components/new-component.css */
   /**
    * New Element/Component Styles
    *
    * Description of what this does
    */
   ```

4. **Import in appropriate index file**:
   ```css
   /* For core elements, add to core/index.css */
   @import './new-element.css';

   /* For other files, add to styles/index.css in correct section */
   @import './components/new-component.css';
   ```

5. **Follow naming convention**:
   ```css
   .semiont-new-component { }
   .semiont-new-component__element { }
   .semiont-new-component--modifier { }
   ```

6. **Include dark mode support**:
   ```css
   [data-theme="dark"] .semiont-new-component { }
   ```

7. **Use design tokens**:
   ```css
   .semiont-new-component {
     padding: var(--semiont-spacing-md);
     color: var(--semiont-text-primary);
     background: var(--semiont-bg-primary);
   }
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