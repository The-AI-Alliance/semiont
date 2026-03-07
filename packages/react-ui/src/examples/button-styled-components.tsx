/**
 * Example: Button styling with Styled Components (CSS-in-JS)
 *
 * This shows how to style the Button component using styled-components
 * by wrapping it and styling based on data attributes.
 */

import styled from 'styled-components';
import { Button as SemiontButton } from '../components/Button/Button';

// Styled wrapper for the Button component
export const StyledButton = styled(SemiontButton)`
  /* Base styles */
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: ${props => props.theme?.typography?.fontFamily?.sans || 'system-ui, -apple-system, sans-serif'};
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  outline: none;

  /* Primary variant */
  &[data-variant="primary"] {
    background-color: ${props => props.theme?.colors?.primary?.[500] || '#0080ff'};
    color: white;

    &:hover:not(:disabled) {
      background-color: ${props => props.theme?.colors?.primary?.[600] || '#0066cc'};
    }

    &:active:not(:disabled) {
      background-color: ${props => props.theme?.colors?.primary?.[700] || '#0052a3'};
    }
  }

  /* Secondary variant */
  &[data-variant="secondary"] {
    background-color: ${props => props.theme?.colors?.neutral?.[100] || '#f3f4f6'};
    color: ${props => props.theme?.colors?.neutral?.[900] || '#111827'};

    &:hover:not(:disabled) {
      background-color: ${props => props.theme?.colors?.neutral?.[200] || '#e5e7eb'};
    }

    &:active:not(:disabled) {
      background-color: ${props => props.theme?.colors?.neutral?.[300] || '#d1d5db'};
    }
  }

  /* Tertiary variant */
  &[data-variant="tertiary"] {
    background-color: transparent;
    color: ${props => props.theme?.colors?.primary?.[500] || '#0080ff'};
    box-shadow: inset 0 0 0 1px ${props => (props.theme?.colors?.primary?.[500] || '#0080ff') + '33'};

    &:hover:not(:disabled) {
      background-color: ${props => (props.theme?.colors?.primary?.[500] || '#0080ff') + '0a'};
    }
  }

  /* Ghost variant */
  &[data-variant="ghost"] {
    background-color: transparent;
    color: inherit;

    &:hover:not(:disabled) {
      background-color: rgba(0, 0, 0, 0.05);
    }

    &:active:not(:disabled) {
      background-color: rgba(0, 0, 0, 0.1);
    }
  }

  /* Danger variant */
  &[data-variant="danger"] {
    background-color: ${props => props.theme?.colors?.error || '#ef4444'};
    color: white;

    &:hover:not(:disabled) {
      background-color: ${props => props.theme?.colors?.errorDark || '#dc2626'};
    }
  }

  /* Warning variant */
  &[data-variant="warning"] {
    background-color: ${props => props.theme?.colors?.warning || '#f59e0b'};
    color: ${props => props.theme?.colors?.neutral?.[900] || '#111827'};

    &:hover:not(:disabled) {
      background-color: ${props => props.theme?.colors?.warningDark || '#d97706'};
    }
  }

  /* Size variants */
  &[data-size="xs"] {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    border-radius: 0.125rem;
    min-height: 1.75rem;
  }

  &[data-size="sm"] {
    padding: 0.375rem 0.75rem;
    font-size: 0.875rem;
    border-radius: 0.25rem;
    min-height: 2rem;
  }

  &[data-size="md"] {
    padding: 0.5rem 1rem;
    font-size: 1rem;
    border-radius: 0.375rem;
    min-height: 2.5rem;
  }

  &[data-size="lg"] {
    padding: 0.625rem 1.5rem;
    font-size: 1.125rem;
    border-radius: 0.375rem;
    min-height: 3rem;
  }

  &[data-size="xl"] {
    padding: 0.75rem 2rem;
    font-size: 1.25rem;
    border-radius: 0.5rem;
    min-height: 3.5rem;
  }

  /* Icon-only buttons */
  &[data-icon-only="true"] {
    &[data-size="xs"] {
      padding: 0.25rem;
      width: 1.75rem;
    }

    &[data-size="sm"] {
      padding: 0.375rem;
      width: 2rem;
    }

    &[data-size="md"] {
      padding: 0.5rem;
      width: 2.5rem;
    }

    &[data-size="lg"] {
      padding: 0.625rem;
      width: 3rem;
    }

    &[data-size="xl"] {
      padding: 0.75rem;
      width: 3.5rem;
    }
  }

  /* Full width */
  &[data-full-width="true"] {
    width: 100%;
  }

  /* Loading state */
  &[data-loading="true"] {
    pointer-events: none;
    opacity: 0.75;
  }

  /* Focus styles */
  &:focus-visible {
    outline: 2px solid ${props => props.theme?.colors?.primary?.[500] || '#0080ff'};
    outline-offset: 2px;
  }

  /* Disabled state */
  &:disabled,
  &[data-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

// Example usage with theme
/* const _theme = {
  colors: {
    primary: '#0080ff',
    primaryDark: '#0066cc',
    primaryDarker: '#0052a3',
    secondary: '#00ffff',
    danger: '#ef4444',
    dangerDark: '#dc2626',
    warning: '#f59e0b',
    warningDark: '#d97706',
    gray100: '#f3f4f6',
    gray200: '#e5e7eb',
    gray300: '#d1d5db',
    gray900: '#111827',
  },
  fonts: {
    sans: 'Inter, system-ui, -apple-system, sans-serif',
  }
}; */

// Example component using styled button
export function ExampleStyledButton() {
  return (
    <StyledButton variant="primary" size="md">
      Styled Components Button
    </StyledButton>
  );
}