# Semiont Frontend Style Guide

## Color System

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

## Button Styles

We have three standard button styles defined in `/src/lib/button-styles.ts`. Use these consistently throughout the application.

### Primary Buttons
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

### Secondary Buttons
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

### Tertiary Buttons
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
Standard input styling:
```typescript
className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
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
```typescript
className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-4"
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

1. **Consistency:** Always use the predefined button styles rather than creating custom button classes
2. **Hierarchy:** Use primary buttons sparingly - typically one per view/modal
3. **Feedback:** Show loading states with spinners or "..." text
4. **Accessibility:** Include proper ARIA labels and keyboard navigation support
5. **Dark Mode:** Always include both light and dark mode styles
6. **Transitions:** Use `transition-all duration-300` for smooth hover effects

## Importing Styles

Always import button styles at the top of your component:

```typescript
import { buttonStyles } from '@/lib/button-styles';
```

For combining custom classes with standard styles:
```typescript
className={`${buttonStyles.primary.base} w-full`}
// or
className={buttonStyles.combine(buttonStyles.primary.base, 'w-full')}
```