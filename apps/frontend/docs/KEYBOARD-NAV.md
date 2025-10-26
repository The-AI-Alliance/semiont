# Keyboard Navigation & Accessibility Architecture

## Executive Summary

The Semiont frontend implements a **fully accessible keyboard navigation experience that meets WCAG 2.1 Level AA standards**. This document describes the architectural principles, implementation patterns, and technical foundations that ensure comprehensive keyboard accessibility throughout the application.

## WCAG 2.1 Level AA Compliance

### Compliance Justification

Our application meets WCAG 2.1 Level AA standards through:

1. **Keyboard Accessible (2.1.1)**: All interactive elements are reachable and operable via keyboard
2. **No Keyboard Trap (2.1.2)**: Users can navigate in and out of all components using standard keys
3. **Focus Visible (2.4.7)**: Clear focus indicators on all interactive elements
4. **Focus Order (2.4.3)**: Logical tab order that follows visual layout and content flow
5. **Bypass Blocks (2.4.1)**: Skip links to main content, navigation, and search
6. **Page Titled (2.4.2)**: Descriptive page titles and headings
7. **Name, Role, Value (4.1.2)**: Proper ARIA labels and semantic HTML

### Implementation Evidence

- **Modal Focus Management**: All modals trap focus and restore on close (Headless UI Dialog)
- **Keyboard Shortcuts**: Documented shortcuts with help modal (`?` key)
- **Skip Links**: Hidden but keyboard-accessible navigation bypass
- **Live Regions**: Screen reader announcements for dynamic content
- **ARIA Implementation**: Comprehensive labeling of interactive elements

## Architectural Principles

### 1. Progressive Enhancement
Start with semantic HTML and enhance with JavaScript. Keyboard navigation works even if advanced features fail.

### 2. Platform Consistency
Follow platform conventions (Cmd on Mac, Ctrl on Windows/Linux) and standard keyboard patterns.

### 3. Discoverability
Make keyboard shortcuts discoverable through visual indicators and comprehensive help documentation.

### 4. Context Awareness
Shortcuts behave differently based on context (e.g., disabled in input fields).

### 5. Accessibility First
Every feature designed with keyboard and screen reader users as primary considerations.

## Technical Architecture

### Core Systems

#### 1. Keyboard Shortcut System
```typescript
// Centralized hook for registering shortcuts
useKeyboardShortcuts([
  {
    key: 'k',
    ctrlOrCmd: true,
    handler: () => openGlobalSearch(),
    description: 'Open global search'
  }
]);
```

**Features**:
- Platform detection (Mac vs Windows/Linux)
- Context-aware activation (not in input fields)
- Modifier key support
- Description for help documentation

#### 2. Focus Management System
```typescript
// Headless UI Dialog handles focus trapping
<Dialog open={isOpen} onClose={onClose}>
  {/* Focus trapped within dialog */}
</Dialog>
```

**Implementation**:
- Focus trap in modals and popups
- Focus restoration on close
- Roving tabindex for complex widgets
- Focus visible indicators

#### 3. Navigation Patterns

**Roving TabIndex**: Used for single-selection widget groups
```typescript
// Custom hook for arrow key navigation
useRovingTabIndex(itemCount, {
  orientation: 'horizontal',
  loop: true
});
```

**Tab Navigation**: Sequential focus through page regions
- Skip links → Header → Main content → Footer
- Logical grouping of related controls

#### 4. Live Region System
```typescript
// Announce dynamic updates to screen readers
<LiveRegionProvider>
  <div role="status" aria-live="polite">
    {announcement}
  </div>
</LiveRegionProvider>
```

**Use Cases**:
- Search result counts
- Form validation errors
- Success confirmations
- Loading states

## Component Patterns

### Modal Dialogs
All modals use Headless UI Dialog component for consistent behavior:
- Focus trap within modal
- Escape key to close
- Click outside to close
- Focus restoration to trigger element

### Form Controls
- Clear labels (visible or screen reader only)
- Error messages announced to screen readers
- Validation state communicated via ARIA
- Logical tab order through fields

### Navigation Menus
- Arrow keys for menu navigation
- Enter/Space to activate items
- Escape to close menus
- Home/End for first/last item

### Data Tables & Grids
- Arrow keys for cell navigation
- Tab to move between regions
- Header associations for screen readers
- Sort controls keyboard accessible

## Global Keyboard Shortcuts

### Application Navigation
- **Cmd/Ctrl + K**: Global search
- **Cmd/Ctrl + N**: New document
- **/**: Alternative search trigger
- **?**: Keyboard shortcuts help
- **Esc Esc**: Close all overlays

### Document Interaction
- **H**: Create highlight from selection
- **R**: Create reference from selection
- **Delete**: Remove selected annotation
- **Tab**: Navigate through annotations

### Modal & Popup Control
- **Escape**: Close active modal
- **Tab/Shift-Tab**: Navigate controls
- **Enter/Space**: Activate buttons
- **Arrow Keys**: Navigate options

## Implementation Patterns

### Custom Hooks

#### useKeyboardShortcuts
Centralized keyboard event handling with platform detection:
```typescript
export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Platform-specific modifier detection
      // Context-aware activation
      // Shortcut matching and execution
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [shortcuts]);
}
```

#### useRovingTabIndex
Arrow key navigation for widget groups:
```typescript
export function useRovingTabIndex(itemCount: number, options: Options) {
  // Manages tabindex attributes
  // Handles arrow key navigation
  // Supports Home/End keys
  // Configurable orientation (horizontal/vertical/grid)
}
```

#### useLiveRegion
Screen reader announcements for dynamic content:
```typescript
export function useLiveRegion() {
  return {
    announce: (message: string, priority: 'polite' | 'assertive') => {
      // Updates ARIA live region
      // Handles announcement priority
      // Auto-clears after announcement
    }
  };
}
```

### Component Integration

All interactive components follow consistent patterns:

1. **Semantic HTML First**: Use native elements when possible
2. **ARIA Enhancement**: Add roles and properties for clarity
3. **Focus Management**: Clear focus states and logical order
4. **Keyboard Handlers**: Standard keys for expected actions

Example implementation:
```tsx
<button
  onClick={handleClick}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }}
  aria-label="Delete annotation"
  aria-describedby={hasError ? 'error-message' : undefined}
  className="focus:outline-none focus:ring-2 focus:ring-cyan-500"
>
  <DeleteIcon aria-hidden="true" />
</button>
```

## Testing Strategy

### Automated Testing
- **Unit Tests**: Keyboard event handlers and focus management
- **Integration Tests**: Complete workflows via keyboard
- **Accessibility Tests**: ARIA attributes and roles

### Manual Testing
- **Keyboard-Only Navigation**: Complete app tour without mouse
- **Screen Reader Testing**: NVDA, JAWS, VoiceOver
- **Browser Testing**: Chrome, Firefox, Safari, Edge

### Validation Tools
- **axe DevTools**: Automated accessibility checking
- **WAVE**: Visual accessibility evaluation
- **Lighthouse**: Performance and accessibility audit

## Browser Compatibility

### Supported Browsers
- Chrome 90+ (Full support)
- Firefox 88+ (Full support)
- Safari 14+ (Full support)
- Edge 90+ (Full support)

### Platform Considerations
- **macOS**: Cmd key for shortcuts, VoiceOver support
- **Windows**: Ctrl key for shortcuts, NVDA/JAWS support
- **Linux**: Ctrl key for shortcuts, Orca support

## Performance Considerations

### Event Handler Optimization
- Debounced search inputs
- Throttled scroll handlers
- Memoized callback functions
- Event delegation where appropriate

### DOM Manipulation
- Minimal re-renders with React.memo
- Virtual focus (only one tabIndex={0})
- Batch DOM updates
- CSS-based focus indicators

## Migration Path

### From Legacy Components
1. Replace native modals with Headless UI Dialog
2. Add ARIA labels to icon buttons
3. Implement focus trap in custom overlays
4. Add keyboard event handlers to clickable divs

### Incremental Adoption
The keyboard navigation system is designed for incremental adoption:
- Start with global shortcuts
- Add modal focus management
- Implement roving tabindex for lists
- Add live regions for dynamic content

## Future Enhancements

### Planned Features
- **Vim Mode**: Advanced keyboard navigation for power users
- **Customizable Shortcuts**: User-defined key bindings
- **Gesture Support**: Touch and trackpad gestures
- **Voice Control**: Speech-based navigation

### Technical Improvements
- **Shortcut Conflict Resolution**: Detect and resolve conflicts
- **Context Bubbling**: Nested shortcut contexts
- **Macro Recording**: Record and replay action sequences
- **Analytics**: Track keyboard usage patterns

## Troubleshooting

### Common Issues

#### Focus Lost
**Problem**: Focus disappears after action
**Solution**: Ensure focus restoration in callbacks

#### Shortcuts Not Working
**Problem**: Keyboard shortcuts don't trigger
**Solution**: Check for input field focus, verify no conflicts

#### Screen Reader Silent
**Problem**: No announcements for actions
**Solution**: Verify live regions, check ARIA attributes

### Debug Tools
```javascript
// Enable keyboard navigation debugging
localStorage.setItem('debug:keyboard', 'true');

// Log all keyboard events
window.addEventListener('keydown', (e) => {
  console.log(`Key: ${e.key}, Modifiers: ${e.ctrlKey}/${e.metaKey}/${e.shiftKey}`);
});
```

## Resources

### Documentation
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [Headless UI Documentation](https://headlessui.com/)

### Tools
- [axe DevTools](https://www.deque.com/axe/devtools/)
- [WAVE](https://wave.webaim.org/)
- [Lighthouse](https://developers.google.com/web/tools/lighthouse)

## Conclusion

The Semiont keyboard navigation system provides comprehensive accessibility through thoughtful architecture, consistent patterns, and thorough implementation. By building on web standards and modern React patterns, we ensure that all users can effectively navigate and interact with the application regardless of their input method or assistive technology needs.