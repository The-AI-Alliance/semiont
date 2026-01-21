/**
 * CSS-Agnostic Button Component
 *
 * This button uses data attributes instead of hardcoded Tailwind classes,
 * allowing users to style it with any CSS solution.
 */

import React, { forwardRef } from 'react';
import { clsx } from 'clsx';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * The visual variant of the button
   */
  variant?: 'primary' | 'secondary' | 'tertiary' | 'danger' | 'warning' | 'ghost';

  /**
   * The size of the button
   */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';

  /**
   * Whether the button should take full width of its container
   */
  fullWidth?: boolean;

  /**
   * Whether the button is in a loading state
   */
  loading?: boolean;

  /**
   * Icon to display before the button text
   */
  leftIcon?: React.ReactNode;

  /**
   * Icon to display after the button text
   */
  rightIcon?: React.ReactNode;

  /**
   * Whether the button should only show an icon (no text padding)
   */
  iconOnly?: boolean;

  /**
   * Whether to show the button in an active/pressed state
   */
  active?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      fullWidth = false,
      loading = false,
      leftIcon,
      rightIcon,
      iconOnly = false,
      active = false,
      className,
      disabled,
      children,
      type = 'button',
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        type={type}
        data-variant={variant}
        data-size={size}
        data-loading={loading ? 'true' : undefined}
        data-full-width={fullWidth ? 'true' : undefined}
        data-icon-only={iconOnly ? 'true' : undefined}
        data-active={active ? 'true' : undefined}
        data-disabled={isDisabled ? 'true' : undefined}
        className={clsx('semiont-button', className)}
        disabled={isDisabled}
        aria-busy={loading}
        aria-disabled={isDisabled}
        {...props}
      >
        {/* Loading spinner */}
        {loading && (
          <span
            className="semiont-button-spinner"
            aria-label="Loading"
          >
            <svg
              className="semiont-spinner-svg"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              width="1em"
              height="1em"
            >
              <circle
                className="semiont-spinner-circle"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
                opacity="0.25"
              />
              <path
                className="semiont-spinner-path"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          </span>
        )}

        {/* Left icon */}
        {leftIcon && !loading && (
          <span className="semiont-button-icon semiont-button-icon-left">
            {leftIcon}
          </span>
        )}

        {/* Button content */}
        {!iconOnly && children && (
          <span className="semiont-button-content">{children}</span>
        )}

        {/* Icon-only content (centered) */}
        {iconOnly && children}

        {/* Right icon */}
        {rightIcon && !loading && (
          <span className="semiont-button-icon semiont-button-icon-right">
            {rightIcon}
          </span>
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';

/**
 * Button Group Component
 *
 * Groups multiple buttons together
 */
export interface ButtonGroupProps {
  children: React.ReactNode;
  /**
   * How to arrange the buttons
   */
  orientation?: 'horizontal' | 'vertical';
  /**
   * Whether buttons should be connected (no gap between them)
   */
  attached?: boolean;
  /**
   * Size of the gap between buttons (when not attached)
   */
  spacing?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

export const ButtonGroup: React.FC<ButtonGroupProps> = ({
  children,
  orientation = 'horizontal',
  attached = false,
  spacing = 'sm',
  className,
}) => {
  return (
    <div
      data-orientation={orientation}
      data-attached={attached ? 'true' : undefined}
      data-spacing={attached ? undefined : spacing}
      className={clsx('semiont-button-group', className)}
      role="group"
    >
      {children}
    </div>
  );
};