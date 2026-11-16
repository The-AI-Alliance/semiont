# Semiont Frontend Style Guide

## CSS Architecture Overview

The Semiont frontend uses a hybrid CSS architecture that combines:
1. **Semantic CSS from @semiont/react-ui** - Framework-agnostic component styles with modular organization
2. **Tailwind CSS** - For app-specific styling and utilities

### Technical Implementation

#### @semiont/react-ui Styles
All React UI components from `@semiont/react-ui` come with semantic CSS classes following BEM methodology. These styles are automatically imported in `globals.css`:

```css
/* apps/frontend/src/app/globals.css */
@import '@semiont/react-ui/styles';
```

The styles are organized into a modular architecture:
- **Core UI Elements** (`core/`) - Fundamental components like buttons, toggles, sliders, badges, tags
- **Components** (`components/`) - Complex composed components like forms, modals, cards
- **Panels** (`panels/`) - Layout containers for content sections
- **Motivations** (`motivations/`) - W3C Web Annotation standard styles
- **Features** (`features/`) - Feature-specific styling

This provides all component styles with the `semiont-` prefix:
- `semiont-button`, `semiont-button--primary` (from `core/buttons.css`)
- `semiont-card`, `semiont-card__header` (from `components/cards.css`)
- `semiont-panel`, `semiont-panel__title` (from `panels/`)
- `semiont-toggle`, `semiont-progress`, `semiont-slider` (from `core/`)
- And more...

#### Tailwind Configuration
The frontend app uses Tailwind for its own components and layout. The configuration excludes @semiont/react-ui from content scanning since it doesn't use Tailwind classes:

```typescript
// tailwind.config.ts
content: [
  "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
  "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  "./src/lib/**/*.{js,ts,jsx,tsx,mdx}",
  // Note: @semiont/react-ui is NOT included
]
```

### Using @semiont/react-ui Components

When using components from @semiont/react-ui, they already have all necessary styling:

```typescript
import { Button, Card, Toolbar } from '@semiont/react-ui';

// Components come pre-styled with semantic classes
<Button variant="primary">Click me</Button>
<Card>
  <Card.Header>Title</Card.Header>
  <Card.Content>Content here</Card.Content>
</Card>
```

### Dark Mode Support

Both systems support dark mode:
- **@semiont/react-ui**: Uses `data-theme="dark"` attribute
- **Frontend Tailwind**: Uses `class="dark"` on HTML element

The frontend handles this coordination automatically through the theme provider.

### Custom Styling Approach

#### For @semiont/react-ui Components
If you need to customize a react-ui component, add additional classes without overriding the semantic ones:

```typescript
// Good - adds spacing without breaking component styles
<Button className="mt-4" variant="primary">Submit</Button>

// Bad - don't override semantic classes
<Button className="my-custom-button" variant="primary">Submit</Button>
```

#### For App-Specific Components
Use Tailwind utilities freely for components defined in the frontend app:

```typescript
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
- `--semiont-panel-title-weight`: 600
- `--semiont-panel-header-margin-bottom`: 1rem
- `--semiont-panel-section-gap`: 1.5rem
- `--semiont-panel-icon-size`: 1.25rem

### Primary Colors
The Semiont design system uses a **blue/cyan** color palette as its primary theme:

- **Primary Blue:** `blue-600` (RGB: 59, 130, 246) - Used for primary actions, links, and selections
- **Cyan Accent:** `cyan-600` (RGB: 6, 182, 212) - Used in gradients and accent elements
- **Blue/Cyan Gradient:** `from-blue-600 to-cyan-600` - Used for buttons, progress bars, and special elements

### Secondary Colors
- **Yellow:** Reserved exclusively for text highlights (`yellow-200` light / `yellow-900/50` dark)
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
Use the blue-to-cyan gradient (`from-blue-600 to-cyan-600`) for:
- Primary action buttons
- Progress bars
- Special interactive elements
- AI detection features

## Core UI Elements from @semiont/react-ui

The react-ui package provides fundamental UI elements in the `core/` directory:

### Toggle Switches
```typescript
// Use the semantic classes from core/toggles.css
<label className="semiont-toggle">
  <input type="checkbox" className="semiont-toggle__input" />
  <span className="semiont-toggle__slider"></span>
</label>
```

### Progress Bars
```typescript
// From core/progress.css
<div className="semiont-progress">
  <div className="semiont-progress__fill" style={{width: '60%'}}></div>
</div>
```

### Range Sliders
```typescript
// From core/sliders.css
<input type="range" className="semiont-slider" min="0" max="100" />
<input type="range" className="semiont-slider semiont-slider--small" /> // Small variant
```

### Tags and Badges
```typescript
// Tags from core/tags.css
<span className="semiont-tag">Category</span>
<span className="semiont-tag semiont-tag--secondary">Secondary</span>

// Badges from core/badges.css
<span className="semiont-badge semiont-badge--admin">Admin</span>
<span className="semiont-badge semiont-badge--active">Active</span>
```

### Status Indicators
```typescript
// From core/indicators.css
<span className="semiont-indicator semiont-indicator--online"></span>
<span className="semiont-indicator semiont-indicator--busy"></span>
```

## W3C Web Annotation Motivations

The react-ui package includes dedicated styles for W3C Web Annotation standard motivations:

### Available Motivation Classes
- `.semiont-motivation--linking` - Blue to cyan gradient (references)
- `.semiont-motivation--highlighting` - Yellow background
- `.semiont-motivation--assessing` - Red wavy underline
- `.semiont-motivation--commenting` - Dashed outline
- `.semiont-motivation--tagging` - Orange to amber gradient

### Usage Example
```typescript
// Apply motivation-specific styling
<div className="semiont-motivation--highlighting">
  Highlighted text
</div>

<div className="semiont-motivation--linking">
  Reference to another resource
</div>
```

## Component Styling Guidelines

### Using @semiont/react-ui Components

Components from @semiont/react-ui come with built-in semantic CSS classes. Here's how to use them:

#### Buttons
```typescript
import { Button } from '@semiont/react-ui';

// Primary button - uses semiont-button semiont-button--primary
<Button variant="primary">Primary Action</Button>

// Secondary button - uses semiont-button semiont-button--secondary
<Button variant="secondary">Secondary Action</Button>

// With additional spacing (combines semantic + utility)
<Button variant="primary" className="mt-4">Submit</Button>
```

#### Cards
```typescript
import { Card } from '@semiont/react-ui';

// Card component with semantic classes
<Card> {/* semiont-card */}
  <div className="semiont-card__header">
    <h3 className="semiont-card__title">Title</h3>
  </div>
  <div className="semiont-card__content">
    Content here
  </div>
</Card>
```

#### Panels
```typescript
// Using semantic classes directly
<div className="semiont-panel">
  <div className="semiont-panel__header">
    <h2 className="semiont-panel__title">Panel Title</h2>
  </div>
  <div className="semiont-panel__content">
    Panel content
  </div>
</div>
```

### App-Specific Styling with Tailwind

For components specific to the frontend app, use Tailwind utilities:

#### Custom Button Styles
We have three standard button styles defined in `/src/lib/button-styles.ts` for app-specific buttons:

##### Primary Buttons
**When to use:** Main call-to-action buttons that represent the primary action on a page or in a modal.

**Style:** Cyan/blue gradient with hover effects

**Examples:**
- "Sign In" / "Sign Up"
- "Create Reference" (in selection popup)
- "New Document"
- "Save" (when it's the main action)

```typescript
import { buttonStyles } from '@/lib/button-styles';

<button className={buttonStyles.primary.base}>Primary Action</button>
<button className={buttonStyles.primary.large}>Large Primary Action</button>
```

##### Secondary Buttons
**When to use:** Supporting actions that are important but not the primary focus.

**Style:** Gray with subtle black/white outline

**Examples:**
- "Search"
- "Cancel"
- "Learn More"
- "Back"

```typescript
<button className={buttonStyles.secondary.base}>Secondary Action</button>
<button className={buttonStyles.secondary.withScale}>Secondary with Hover Scale</button>
```

##### Tertiary Buttons
**When to use:** Less important actions, navigation items, or options within a set.

**Style:** Minimal, with just text and hover background

**Examples:**
- Entity type selection buttons (when unselected)
- Navigation items
- "View More" links
- Filter options

```typescript
<button className={buttonStyles.tertiary.base}>Tertiary Action</button>
```

## Special Cases

### Highlight Button
The "Create Highlight" button uses a custom yellow theme to match the visual language of highlights:

```typescript
className="w-full py-2 bg-yellow-200 hover:bg-yellow-300 dark:bg-yellow-900/50 dark:hover:bg-yellow-800/50 border border-yellow-400/30 dark:border-yellow-600/30 text-gray-900 dark:text-white rounded-lg transition-all duration-300"
```

### Selected States
When showing selected items, use blue backgrounds:
- **Entity type selections:** `bg-blue-100 dark:bg-blue-900/30`
- **Document/reference selections:** `bg-blue-50 dark:bg-blue-900/20`
- **Active filters:** `bg-blue-100 dark:bg-blue-900/30 border border-blue-300`

### Disabled States
All button styles include `disabled:opacity-50 disabled:cursor-not-allowed`. Always disable buttons when:
- An action is in progress
- Required fields are empty
- The action is not available

## Annotation Styles

Annotation styles are centralized in `/src/lib/annotation-styles.ts` for consistent appearance across the application.

### Highlights
- **Background:** Yellow (`bg-yellow-200 dark:bg-yellow-900/50`)
- **Border:** Dashed outline for visibility in dark mode
- **Hover:** Deeper yellow (`bg-yellow-300 dark:bg-yellow-900/60`)
- **Purpose:** Visual prominence for highlighted text

### References (All Types)
- **Background:** Cyan/blue gradient (`from-cyan-200 to-blue-200`)
- **Border:** Dashed outline for visibility (`outline-cyan-500/60`)
- **Hover:** Deeper blue gradient
- **Purpose:** Show connections between documents and entities
- **Note:** All references use the same blue/cyan styling for consistency

### Usage
```typescript
import { annotationStyles } from '@/lib/annotation-styles';

// Get style for an annotation
const className = annotationStyles.getAnnotationStyle(annotation);

// Use specific styles
<span className={annotationStyles.highlight.className}>Highlighted text</span>
<span className={annotationStyles.tags.entity}>Entity tag</span>
```

### Administrative/Moderation
- **Active nav items:** Blue (`bg-blue-50 dark:bg-blue-900/20`)
- **All tags:** Blue (`bg-blue-100 dark:bg-blue-900/30`)
- **Focus states:** Blue ring (`focus:ring-blue-500`)

## Form Elements

### Text Inputs
Standard input styling using Tailwind:
```typescript
className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
```

For @semiont/react-ui form components:
```typescript
<div className="semiont-form__field">
  <label className="semiont-form__label">Label</label>
  <input className="semiont-form__input" />
  <p className="semiont-form__helper-text">Helper text</p>
</div>
```

### Select Dropdowns
```typescript
className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
```

## Layout Patterns

### Modal/Popup Structure
1. **Header:** Sticky top with title and close button
2. **Content:** Scrollable main area with consistent padding (`p-4`)
3. **Actions:** Bottom area with primary/secondary buttons

### Card Components
For app-specific cards using Tailwind:
```typescript
className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-4"
```

For @semiont/react-ui cards:
```typescript
<div className="semiont-card">
  {/* Card content */}
</div>
```

### Navigation Sidebars
- Width: `w-64`
- Background: `bg-white dark:bg-gray-900`
- Border: `border-r border-gray-200 dark:border-gray-700`

## SemiontBranding Component

The `SemiontBranding` component is our main brand identity element, featuring the "SEMIONT" text with the "make meaning" tagline. It's resizable and used in different contexts throughout the application.

### Component Props
```typescript
interface SemiontBrandingProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showTagline?: boolean;
  compactTagline?: boolean;  // Shows tagline on same line with backslash separator
  animated?: boolean;         // Adds fade-in animation
  className?: string;
}
```

### Size Variants

#### Small (`size="sm"`)
**When to use:** Headers and navigation bars where space is limited

**Where used:**
- DashboardHeader (top left corner)
- Authenticated pages header

**Example:**
```typescript
<SemiontBranding
  size="sm"
  showTagline={true}
  compactTagline={true}  // "SEMIONT \ make meaning" on one line
  animated={false}
/>
```

#### Medium (`size="md"`)
**When to use:** Default size for general use

**Example:**
```typescript
<SemiontBranding />  // Defaults to md
```

#### Large (`size="lg"`)
**When to use:** Feature sections, about pages

**Example:**
```typescript
<SemiontBranding
  size="lg"
  showTagline={true}
  animated={true}
/>
```

#### Extra Large (`size="xl"`)
**When to use:** Hero sections and landing pages

**Where used:**
- Home page hero section
- Landing page above the CTA buttons

**Example:**
```typescript
<SemiontBranding
  size="xl"
  animated={true}
  className="mb-8"
/>
```

### Styling Details

The component uses the Orbitron font for "SEMIONT" and includes:
- **Gradient text:** Cyan to blue gradient for brand consistency
- **Animation:** Optional fade-in effect for landing pages
- **Responsive sizing:** Text scales appropriately for each size variant
- **Dark mode support:** Adjusts gradient and colors for dark backgrounds

### Usage Guidelines

1. **Headers:** Use `size="sm"` with `compactTagline={true}` to keep navigation compact
2. **Landing pages:** Use `size="xl"` with `animated={true}` for visual impact
3. **Click behavior:** In headers, wrap with Link to make it navigate to home/dashboard
4. **Spacing:** The component doesn't include margin/padding - add via `className` prop

### Typography Scale
- **Small:** `text-xl` (SEMIONT), `text-xs` (tagline)
- **Medium:** `text-2xl` (SEMIONT), `text-sm` (tagline)
- **Large:** `text-4xl` (SEMIONT), `text-base` (tagline)
- **Extra Large:** `text-6xl` (SEMIONT), `text-lg` (tagline)

## Best Practices

### CSS Architecture
1. **Component Organization:** @semiont/react-ui styles are organized into:
   - `core/` - Fundamental UI elements (buttons, toggles, sliders)
   - `components/` - Complex components (forms, modals, cards)
   - `panels/` - Panel layouts and containers
   - `motivations/` - W3C Web Annotation standard styles
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
Always import button styles at the top of your component:

```typescript
import { buttonStyles } from '@/lib/button-styles';
```

### For Combining Classes
```typescript
// Combining semantic + utility classes
className={`${buttonStyles.primary.base} w-full`}

// Using clsx for conditional classes
import clsx from 'clsx';
className={clsx(
  'semiont-button semiont-button--primary',
  isLoading && 'opacity-50'
)}
```

## File Organization

### Frontend App Files
- `/src/lib/button-styles.ts` - App-specific button styles using Tailwind
- `/src/lib/annotation-styles.ts` - Annotation and highlight styles
- `/src/app/globals.css` - Global styles and @semiont/react-ui import

### @semiont/react-ui Style Organization
- `@semiont/react-ui/styles/` - Main styles directory
  - `index.css` - Entry point that imports all styles
  - `variables.css` - Design tokens and CSS custom properties
  - `core/` - Fundamental UI elements
    - `buttons.css`, `toggles.css`, `progress.css`, `sliders.css`
    - `badges.css`, `tags.css`, `indicators.css`
  - `components/` - Complex composed components
  - `panels/` - Panel layouts (12 different panel styles)
  - `motivations/` - W3C Web Annotation standard (5 motivation styles)
  - `features/` - Feature-specific styling
  - `utilities/` - Accessibility and interaction helpers