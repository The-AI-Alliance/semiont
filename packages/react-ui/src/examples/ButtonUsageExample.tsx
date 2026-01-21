/**
 * Example: Using the CSS-agnostic Button component
 *
 * This demonstrates how to use the Button component with different
 * styling approaches and all its features.
 */

import React from 'react';
import { Button, ButtonGroup } from '../components/Button/Button';

// Import styles (users can replace this with their own styles)
import '../styles/index.css';

export function ButtonUsageExample() {
  const [loading, setLoading] = React.useState(false);

  const handleClick = () => {
    setLoading(true);
    // Simulate async operation
    setTimeout(() => setLoading(false), 2000);
  };

  return (
    <div className="button-examples">
      <h2>Button Component Examples</h2>

      {/* Variants */}
      <section>
        <h3>Variants</h3>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="tertiary">Tertiary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="warning">Warning</Button>
          <Button variant="ghost">Ghost</Button>
        </div>
      </section>

      {/* Sizes */}
      <section>
        <h3>Sizes</h3>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Button size="xs">Extra Small</Button>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button size="xl">Extra Large</Button>
        </div>
      </section>

      {/* With Icons */}
      <section>
        <h3>With Icons</h3>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <Button
            variant="primary"
            leftIcon={
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 2a8 8 0 100 16 8 8 0 000-16zM8 7a1 1 0 012 0v4a1 1 0 11-2 0V7zm2 8a1 1 0 100-2 1 1 0 000 2z"/>
              </svg>
            }
          >
            With Left Icon
          </Button>

          <Button
            variant="secondary"
            rightIcon={
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd"/>
              </svg>
            }
          >
            With Right Icon
          </Button>

          <Button
            variant="tertiary"
            leftIcon={
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path d="M8 2a1 1 0 000 2h2a1 1 0 100-2H8z"/>
                <path d="M3 5a2 2 0 012-2 1 1 0 000 2H5a2 2 0 00-2 2v6h2V7h10v6h2V7a2 2 0 00-2-2h-.5a1 1 0 000-2H15a2 2 0 012 2v8a2 2 0 01-2 2h-2v3a1 1 0 11-2 0v-3H9v3a1 1 0 11-2 0v-3H5a2 2 0 01-2-2V5z"/>
              </svg>
            }
            rightIcon={
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd"/>
              </svg>
            }
          >
            Both Icons
          </Button>
        </div>
      </section>

      {/* Icon Only */}
      <section>
        <h3>Icon Only Buttons</h3>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <Button variant="primary" size="sm" iconOnly>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z"/>
            </svg>
          </Button>

          <Button variant="secondary" size="md" iconOnly>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/>
            </svg>
          </Button>

          <Button variant="ghost" size="lg" iconOnly>
            <svg width="24" height="24" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd"/>
            </svg>
          </Button>
        </div>
      </section>

      {/* States */}
      <section>
        <h3>States</h3>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <Button variant="primary">Normal</Button>
          <Button variant="primary" active>Active/Pressed</Button>
          <Button variant="primary" disabled>Disabled</Button>
          <Button variant="primary" loading onClick={handleClick}>
            {loading ? 'Loading...' : 'Click to Load'}
          </Button>
        </div>
      </section>

      {/* Full Width */}
      <section>
        <h3>Full Width</h3>
        <div style={{ maxWidth: '400px' }}>
          <Button variant="primary" fullWidth>
            Full Width Button
          </Button>
        </div>
      </section>

      {/* Button Groups */}
      <section>
        <h3>Button Groups</h3>

        <div style={{ marginBottom: '1rem' }}>
          <h4>Horizontal Group</h4>
          <ButtonGroup orientation="horizontal" spacing="sm">
            <Button variant="secondary" size="sm">First</Button>
            <Button variant="secondary" size="sm">Second</Button>
            <Button variant="secondary" size="sm">Third</Button>
          </ButtonGroup>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <h4>Attached Group</h4>
          <ButtonGroup orientation="horizontal" attached>
            <Button variant="primary">Previous</Button>
            <Button variant="primary" active>Current</Button>
            <Button variant="primary">Next</Button>
          </ButtonGroup>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <h4>Vertical Group</h4>
          <ButtonGroup orientation="vertical" spacing="xs">
            <Button variant="ghost" fullWidth>Option 1</Button>
            <Button variant="ghost" fullWidth>Option 2</Button>
            <Button variant="ghost" fullWidth>Option 3</Button>
          </ButtonGroup>
        </div>

        <div>
          <h4>Mixed Variants Group</h4>
          <ButtonGroup orientation="horizontal" spacing="md">
            <Button variant="danger">Delete</Button>
            <Button variant="warning">Archive</Button>
            <Button variant="primary">Save</Button>
          </ButtonGroup>
        </div>
      </section>

      {/* Custom Styling */}
      <section>
        <h3>Custom Styling</h3>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {/* Example with inline styles */}
          <Button
            variant="primary"
            style={{
              backgroundColor: '#8b5cf6',
              borderRadius: '9999px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em'
            }}
          >
            Custom Inline Styles
          </Button>

          {/* Example with custom className */}
          <Button
            variant="secondary"
            className="custom-button-class"
          >
            Custom Class
          </Button>
        </div>
      </section>

      {/* Accessibility Example */}
      <section>
        <h3>Accessibility</h3>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <Button
            variant="primary"
            aria-label="Save document"
            aria-describedby="save-description"
          >
            Save
          </Button>
          <span id="save-description" style={{ fontSize: '0.875rem', color: '#6b7280' }}>
            Saves the current document to your drafts
          </span>
        </div>
      </section>

      {/* Form Integration */}
      <section>
        <h3>Form Integration</h3>
        <form onSubmit={(e) => { e.preventDefault(); alert('Form submitted!'); }}>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <Button type="button" variant="ghost">Cancel</Button>
            <Button type="reset" variant="secondary">Reset</Button>
            <Button type="submit" variant="primary">Submit</Button>
          </div>
        </form>
      </section>
    </div>
  );
}