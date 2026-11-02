import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The app's icon radio-popover: a quiet icon button that opens a small menu of exclusive
 * options. Used for the footer viewer prefs (click action, motivation) and the per-resource
 * shape badge. The popover opens upward by default (footer placement); pass `prefctl--down`
 * in `className` to open it downward (corner-badge / header placement).
 */
export function PrefMenu<T extends string>({
  ariaLabel,
  buttonIcon,
  className,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  /** Fixed control-identity glyph for the button; omitted → the current value's icon. */
  buttonIcon?: ReactNode;
  /** Extra classes on the root (placement variants like `prefctl--down msg__shapectl`). */
  className?: string;
  options: Array<{ value: T; icon: ReactNode; label: string; hint: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  // Click-away closes the popover.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className={`prefctl${className !== undefined ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className="prefctl__btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={ariaLabel}
        title={`${ariaLabel}: ${current?.label ?? ''}`}
      >
        <span aria-hidden="true">{buttonIcon ?? current?.icon}</span>
      </button>
      {open && (
        <div className="prefctl__panel" role="menu" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className={`prefctl__option${option.value === value ? ' prefctl__option--on' : ''}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              title={option.hint}
            >
              <span aria-hidden="true">{option.icon}</span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
