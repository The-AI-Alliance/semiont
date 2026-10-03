# Semiont Browser Style Guide

## CSS Architecture Overview

The Semiont Browser uses a hybrid CSS architecture that combines:
1. **Semantic CSS from @semiont/react-ui** - Framework-agnostic component styles with modular organization
2. **Tailwind CSS** - For app-specific styling and utilities

### Technical Implementation

#### @semiont/react-ui Styles
All React UI components from `@semiont/react-ui` come with semantic CSS classes following BEM methodology. These styles are imported in `globals.css`, ahead of Tailwind:

```css
/* apps/browser/src/app/globals.css */
@import '@semiont/react-ui/styles';
@import "tailwindcss";
```

The styles are organized into a modular architecture:
- **Core UI Elements** (`core/`) - Fundamental elements like buttons, toggles, sliders, inputs, tags
- **Patterns** (`patterns/`) - Shared panel and card structures
- **Panels** (`panels/`) - Styles for individual panels
- **Motivations** (`motivations/`) - W3C Web Annotation standard styles
- **Features** (`features/`) - Feature-specific styling
- **Component-level CSS** - Composed components (modals, navigation, resource panels, toolbar) keep their CSS beside their code

This provides all component styles with the `semiont-` prefix:
- `semiont-button`, `semiont-button--primary` (from `core/buttons.css`)
- `semiont-card` (from `patterns/cards.css`)
- `semiont-panel`, `semiont-panel-header__title` (from `patterns/panels-base.css`)
- `semiont-toggle`, `semiont-progress`, `semiont-slider` (from `core/`)
- And more...

#### Tailwind Configuration
The Browser app uses Tailwind for its own components and layout. `globals.css` loads `tailwind.config.js` with `@config` and names the sources Tailwind scans for class names — the Browser's own `src`, and `packages/react-ui/src`:

```css
/* apps/browser/src/app/globals.css */
@config "../../tailwind.config.js";
@plugin "@tailwindcss/typography";
@source "../../src";
@source "../../../../packages/react-ui/src";
```

### Using @semiont/react-ui Components

When using components from @semiont/react-ui, they already have all necessary styling:

```tsx
import { Button, Toolbar } from '@semiont/react-ui';

// Components come pre-styled with semantic classes
<Button variant="primary">Click me</Button>
```

### Dark Mode Support

`ThemeProvider` from @semiont/react-ui resolves the theme (`light`, `dark`, or `system`) and sets `data-theme` on the `<html>` element. The react-ui styles and the Browser's `globals.css` key their dark rules off `[data-theme="dark"]`.

The Browser's `tailwind.config.js` sets `darkMode: 'class'`, so Tailwind's `dark:` variants respond to a `dark` class on an ancestor — a class `ThemeProvider` does not set.

### Custom Styling Approach

#### For @semiont/react-ui Components
If you need to customize a react-ui component, add additional classes without overriding the semantic ones:

```tsx
// Good - adds spacing without breaking component styles
const spaced = <Button className="mt-4" variant="primary">Submit</Button>;

// Bad - don't override semantic classes
const overridden = <Button className="my-custom-button" variant="primary">Submit</Button>;
```

#### For App-Specific Components
Use Tailwind utilities freely for components defined in the Browser app:

```tsx
// App-specific component using Tailwind
<div className="flex items-center gap-4 p-6 bg-white dark:bg-gray-800">
  <span className="text-lg font-semibold">Custom content</span>
</div>
```

## Color System

### Design Tokens
The design system uses CSS custom properties from @semiont/react-ui:
- `--semiont-color-primary-*`: Blue color scale
- `--semiont-color-gray-*`: Neutral color scale
- `--semiont-color-red-*`, `--semiont-color-green-*`, etc.: Semantic colors
- `--semiont-color-yellow-*`: Full yellow palette for highlights
- `--semiont-color-orange-*`, `--semiont-color-amber-*`: For tagging motivations

### Panel Design Tokens
Centralized tokens ensure consistency across all panels:
- `--semiont-panel-padding`: 1rem
- `--semiont-panel-title-size`: var(--semiont-text-lg)
- `--semiont-panel-title-weight`: var(--semiont-font-semibold)
- `--semiont-panel-header-margin-bottom`: 0.75rem
- `--semiont-panel-section-gap`: 1.5rem
- `--semiont-panel-icon-size`: 1.125rem

### Primary Colors
The Semiont design system uses a **blue/cyan** color palette as its primary theme:

- **Primary Blue:** `--semiont-color-blue-500` (RGB: 59, 130, 246) - Used for primary actions, links, and selections
- **Cyan Accent:** `--semiont-color-cyan-500` (RGB: 6, 182, 212) - Used in gradients and accent elements
- **Cyan/Blue Gradient:** `--semiont-gradient-primary` - Cyan-500 to blue-500 at 20% opacity, deepening to cyan-600 → blue-600 on hover

### Secondary Colors
- **Yellow:** Reserved exclusively for text highlights (yellow-200 light / yellow-900 at 50% dark)
- **Green:** Success states and completion messages
- **Red:** Error states and destructive actions
- **Gray:** Neutral UI elements, backgrounds, and disabled states

### Color Usage Guidelines

#### Blue/Cyan for Primary UI Elements
Use blue and cyan colors for:
- Primary buttons and call-to-action elements
- Selected states and active filters
- Progress indicators and loading states
- Links and interactive elements
- Entity type tags and reference tags
- Focus rings and form inputs
- Detection progress and AI-powered features

#### Yellow for Highlights
Yellow is reserved exclusively for text highlights in documents. This creates a clear visual distinction between highlighted text and interactive references.

#### Gradients
The cyan-to-blue gradient (`--semiont-gradient-primary`) marks primary action buttons (`semiont-button--primary`). Reference annotations carry a lighter cyan-to-blue gradient (`--semiont-motivation-reference-bg`).

## Core UI Elements from @semiont/react-ui

The react-ui package provides fundamental UI elements in the `core/` directory:

### Toggle Switches
```tsx
// From core/toggles.css
const [isOn, setIsOn] = useState(false);

<label className="semiont-toggle-label">
  <span className="semiont-toggle-label__text">Line numbers</span>
  <button
    type="button"
    role="switch"
    aria-checked={isOn}
    onClick={() => setIsOn(!isOn)}
    className={`semiont-toggle ${isOn ? 'semiont-toggle--active' : ''}`}
  >
    <span className={`semiont-toggle__slider ${isOn ? 'semiont-toggle__slider--active' : ''}`} />
  </button>
</label>
```

### Progress Bars
```tsx
// From core/progress.css
<div className="semiont-progress">
  <div className="semiont-progress__fill" style={{width: '60%'}}></div>
</div>
```

### Range Sliders
```tsx
// From core/sliders.css
<>
  <input type="range" className="semiont-slider" min="0" max="100" />
  {/* Small variant */}
  <input type="range" className="semiont-slider semiont-slider--small" />
</>
```

### Tags
```tsx
// From core/tags.css
<>
  <span className="semiont-tag">Category</span>
  <span className="semiont-tag semiont-tag--secondary">Secondary</span>
</>
```

### Status Indicators
```tsx
// From core/indicators.css
<>
  <span className="semiont-indicator semiont-indicator--online"></span>
  <span className="semiont-indicator semiont-indicator--busy"></span>
</>
```

## W3C Web Annotation Motivations

The react-ui package includes dedicated styles for W3C Web Annotation standard motivations, one file per motivation in `motivations/`.

### Available Motivation Classes
- `.annotation-reference` - Cyan to blue gradient (linking)
- `.annotation-highlight` - Yellow background (highlighting)
- `.annotation-assessment` - Red wavy underline (assessing)
- `.annotation-comment` - Dashed outline (commenting)
- `.annotation-tag` - Orange to amber gradient (tagging)

Which class an annotation gets is decided by the `ANNOTATORS` registry — see [Annotation Styles](#annotation-styles).

## Component Styling Guidelines

### Using @semiont/react-ui Components

Components from @semiont/react-ui come with built-in semantic CSS classes. Here's how to use them:

#### Buttons
```tsx
import { Button } from '@semiont/react-ui';

// Primary button - renders class="semiont-button" data-variant="primary"
const primary = <Button variant="primary">Primary Action</Button>;

// Secondary button - renders class="semiont-button" data-variant="secondary"
const secondary = <Button variant="secondary">Secondary Action</Button>;

// With additional spacing (combines semantic + utility)
const spaced = <Button variant="primary" className="mt-4">Submit</Button>;
```

#### Cards
```tsx
// A card is a class, not a component
<div className="semiont-card">
  <h3>Title</h3>
  <p>Content here</p>
</div>
```

#### Panels
```tsx
// Using semantic classes directly
<div className="semiont-panel">
  <div className="semiont-panel-header">
    <h2 className="semiont-panel-header__title">Panel Title</h2>
  </div>
  <div className="semiont-panel__content">
    Panel content
  </div>
</div>
```

### Button Class Strings

For a plain `<button>`, `@semiont/react-ui` exports `buttonStyles`: ready-made `semiont-button` class strings. The Browser's home page renders its Begin button with `buttonStyles.primary.base`.

#### Primary Buttons
**When to use:** Main call-to-action buttons that represent the primary action on a page or in a modal.

**Style:** Cyan/blue gradient with hover effects

**Examples:**
- "Sign In" / "Sign Up"
- "Create Reference" (in selection popup)
- "New Document"
- "Save" (when it's the main action)

```tsx
import { buttonStyles } from '@semiont/react-ui';

<>
  <button className={buttonStyles.primary.base}>Primary Action</button>
  <button className={buttonStyles.primary.large}>Large Primary Action</button>
</>
```

#### Secondary Buttons
**When to use:** Supporting actions that are important but not the primary focus.

**Style:** Gray with subtle black/white outline

**Examples:**
- "Search"
- "Cancel"
- "Learn More"
- "Back"

```tsx
<>
  <button className={buttonStyles.secondary.base}>Secondary Action</button>
  <button className={buttonStyles.secondary.withScale}>Secondary with Hover Scale</button>
</>
```

#### Tertiary Buttons
**When to use:** Less important actions, navigation items, or options within a set.

**Style:** Minimal, with just text and hover background

**Examples:**
- Entity type selection buttons (when unselected)
- Navigation items
- "View More" links
- Filter options

```tsx
<button className={buttonStyles.tertiary.base}>Tertiary Action</button>
```

`buttonStyles.danger.base` covers destructive actions.

## Special Cases

### Highlight Button
For a highlight action, use the amber `buttonStyles.warning.base` (`semiont-button--warning`), which matches the visual language of highlights:

```tsx
<button className={buttonStyles.warning.base}>Highlight</button>
```

### Selected States
When showing selected items, use blue backgrounds:
- **Entity type selections:** `bg-blue-100 dark:bg-blue-900/30`
- **Document/reference selections:** `bg-blue-50 dark:bg-blue-900/20`
- **Active filters:** `bg-blue-100 dark:bg-blue-900/30 border border-blue-300`

### Disabled States
Every `semiont-button` dims to 50% opacity with a `not-allowed` cursor when it is `:disabled` or carries `data-disabled="true"`. Always disable buttons when:
- An action is in progress
- Required fields are empty
- The action is not available

## Annotation Styles

Each motivation's class name lives in the `ANNOTATORS` registry (`packages/react-ui/src/lib/annotation-registry.ts`); its colours live in `packages/react-ui/src/styles/motivations/`.

### Highlights
- **Background:** Yellow (`--semiont-motivation-highlight-bg`: yellow-200; yellow-900 at 50% in dark mode)
- **Border:** Dashed outline in dark mode
- **Hover:** Deeper yellow (yellow-300; yellow-900 at 60% in dark mode)
- **Purpose:** Visual prominence for highlighted text

### References (All Types)
- **Background:** Cyan/blue gradient (`--semiont-motivation-reference-bg`: cyan-200 → blue-200)
- **Border:** Dashed cyan outline in dark mode
- **Hover:** Deeper gradient (cyan-300 → blue-300)
- **Purpose:** Show connections between documents and entities
- **Note:** All references use the same blue/cyan styling for consistency

### Usage
```tsx
import { ANNOTATORS } from '@semiont/react-ui';

// The annotator whose motivation matches supplies the class
const annotator = Object.values(ANNOTATORS).find((a) => a.matchesAnnotation(annotation));

<span className={annotator?.className}>Annotated text</span>
```

### Administrative/Moderation
- **Active nav items:** Blue (`bg-blue-50 dark:bg-blue-900/20`)
- **All tags:** Blue (`bg-blue-100 dark:bg-blue-900/30`)
- **Focus states:** Blue ring (`focus:ring-blue-500`)

## Form Elements

### Text Inputs
Inputs take react-ui's `semiont-input` (`core/inputs.css`), as the Browser's `KnowledgeBasePanel` form does. A labelled field wraps it in the `core/forms.css` classes:

```tsx
<div className="semiont-form__field">
  <label htmlFor="host" className="semiont-form__label">Host</label>
  <input id="host" type="text" className="semiont-input" />
  <p className="semiont-form__help">Helper text</p>
</div>
```

### Select Dropdowns
```tsx
<select className="semiont-select">
  <option value="http">HTTP</option>
  <option value="https">HTTPS</option>
</select>
```

## Layout Patterns

### Modal/Popup Structure
1. **Header:** Sticky top with title and close button
2. **Content:** Scrollable main area with consistent padding (`p-4`)
3. **Actions:** Bottom area with primary/secondary buttons

### Card Components
```tsx
<div className="semiont-card">
  {/* Card content */}
</div>
```

### Navigation Sidebars
The knowledge and moderation layouts use react-ui's `LeftSidebar`, styled by its own `LeftSidebar.css`.

## SemiontBranding Component

The `SemiontBranding` component is our main brand identity element: the "SEMIONT" wordmark over a tagline, which it renders as `t('tagline')` — "make meaning" under the Browser's `Home` messages. It's resizable and used in different contexts throughout the application.

### Component Props
```tsx
<SemiontBranding
  t={tHome}               // required: renders t('tagline')
  size="lg"               // 'sm' | 'md' | 'lg' | 'xl'; default 'lg'
  showTagline={true}      // default true
  animated={true}         // fade-in animation; default true
  compactTagline={false}  // wider tagline letter-spacing; default false
  className=""            // appended to semiont-branding
/>
```

### Size Variants

#### Small (`size="sm"`)
**When to use:** Headers and navigation bars where space is limited

**Where used:**
- `UnifiedHeader` (the branding button that opens the navigation menu)
- `LeftSidebar`, expanded, without the tagline

**Example:**
```tsx
<SemiontBranding
  t={tHome}
  size="sm"
  showTagline={true}
  compactTagline={true}
  animated={false}
/>
```

#### Medium (`size="md"`)
**When to use:** General use

**Example:**
```tsx
<SemiontBranding t={tHome} size="md" />
```

#### Large (`size="lg"`)
**When to use:** Feature sections, about pages. `lg` is the default size.

**Example:**
```tsx
<SemiontBranding t={tHome} />
```

#### Extra Large (`size="xl"`)
**When to use:** Hero sections and landing pages

**Where used:**
- The Browser's home page (`src/app/[locale]/page.tsx`), above the Begin button

**Example:**
```tsx
<SemiontBranding
  t={tHome}
  size="xl"
  animated={true}
  className="mb-8"
/>
```

### Styling Details

The component uses the Orbitron font for "SEMIONT" and includes:
- **Gradient text:** Black → primary-600 → black, and white → primary-400 → white in dark mode
- **Animation:** Optional fade-in effect for landing pages
- **Responsive sizing:** Title and tagline sizes are set per `data-size` in `Branding.css`, and the title steps up at the 640px and 768px breakpoints
- **Dark mode support:** Adjusts gradient and colors for dark backgrounds

### Usage Guidelines

1. **Headers:** Use `size="sm"` with `compactTagline={true}` to keep navigation compact
2. **Landing pages:** Use `size="xl"` with `animated={true}` for visual impact
3. **Click behavior:** In headers, wrap with Link to make it navigate to home/dashboard
4. **Spacing:** The component doesn't include outer margin/padding - add via `className` prop

## Best Practices

### CSS Architecture
1. **Component Organization:** @semiont/react-ui styles are organized into:
   - `core/` - Fundamental UI elements (buttons, toggles, sliders, inputs)
   - `patterns/` - Shared panel and card structures
   - `panels/` - Styles for individual panels
   - `motivations/` - W3C Web Annotation standard styles
   - CSS beside each composed component under `src/components/`
2. **Use Design Tokens:** Leverage panel design tokens and CSS variables for consistency
3. **App Styles:** Use Tailwind for app-specific components and layouts
4. **Don't Mix:** Avoid overriding semantic classes from @semiont/react-ui with Tailwind utilities
5. **Custom Properties:** Use CSS variables from @semiont/react-ui (colors, spacing, typography)

### Style Guidelines
1. **Consistency:** Always use the predefined styles rather than creating custom classes
2. **Hierarchy:** Use primary buttons sparingly - typically one per view/modal
3. **Feedback:** Show loading states with spinners or "..." text
4. **Accessibility:** Include proper ARIA labels and keyboard navigation support
5. **Dark Mode:** Always include both light and dark mode styles
6. **Transitions:** Use `transition-all duration-300` for smooth hover effects

## Migration Notes

When migrating components:
1. **Check @semiont/react-ui first:** See if the component exists in the UI library
2. **Use semantic classes:** If using react-ui components, rely on their semantic CSS
3. **Add utility classes carefully:** Only add Tailwind utilities for spacing/layout, not core styling
4. **Test dark mode:** Ensure both `data-theme="dark"` (react-ui) and `dark:` (Tailwind) work correctly

## Importing Styles

### For App Components
Import button styles from `@semiont/react-ui` at the top of your component:

```typescript
import { buttonStyles } from '@semiont/react-ui';
```

### For Combining Classes
```tsx
// Combining semantic + utility classes
<button className={`${buttonStyles.primary.base} w-full`}>Save</button>
```

react-ui's `Button` merges its `className` prop after `semiont-button`, so `<Button className="mt-4">` combines the two the same way.

## File Organization

### Browser App Files
- `src/app/globals.css` - Global styles, the @semiont/react-ui import, and the Tailwind setup
- `tailwind.config.js` - Tailwind configuration (`darkMode`, theme extensions)

### @semiont/react-ui Style Organization
- `@semiont/react-ui/styles/` - Main styles directory
  - `index.css` - Entry point that imports all styles, including component-level CSS
  - `variables.css` - Design tokens and CSS custom properties
  - `base/` - Reset and semantic utility classes
  - `core/` - Fundamental UI elements
    - `buttons.css`, `toggles.css`, `progress.css`, `sliders.css`
    - `inputs.css`, `checkboxes.css`, `textareas.css`, `selects.css`, `forms.css`
    - `badges.css`, `tags.css`, `indicators.css`
  - `patterns/` - Shared panel and card structures
  - `panels/` - History and user panel styles
  - `motivations/` - W3C Web Annotation standard (5 motivation styles)
  - `features/` - Feature-specific styling
  - `layout/` - Page and container layouts
  - `utilities/` - Accessibility and interaction helpers
