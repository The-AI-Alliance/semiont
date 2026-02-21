'use client';

import React, { useCallback, useRef, useEffect } from 'react';
import { useEventBus } from '../../contexts/EventBusContext';

/**
 * Props for ObservableLink component
 *
 * Accepts any props that a standard anchor element accepts,
 * plus optional navigation metadata for event emission.
 */
export interface ObservableLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  /** The URL to navigate to */
  href: string;
  /** Optional label for the link (used in event metadata) */
  label?: string;
  /** Children to render inside the link */
  children: React.ReactNode;
}

/**
 * Link component that emits navigation events for observability
 *
 * Use this instead of Next.js <Link> when you want link clicks to be
 * observable through the NavigationEventBus. This is useful for:
 * - Analytics tracking
 * - State coordination before navigation
 * - Logging navigation flows
 *
 * The component emits 'navigation:link-clicked' event before allowing
 * the browser to follow the link.
 *
 * @example
 * ```typescript
 * <ObservableLink
 *   href="/know/discover"
 *   label="Discover"
 * >
 *   Discover Resources
 * </ObservableLink>
 * ```
 *
 * @example With Next.js Link integration
 * ```typescript
 * import Link from 'next/link';
 *
 * <Link href="/know/discover" legacyBehavior passHref>
 *   <ObservableLink label="Discover">
 *     Discover Resources
 *   </ObservableLink>
 * </Link>
 * ```
 *
 * @emits navigation:link-clicked - Link clicked by user. Payload: { href: string, label?: string }
 */
export function ObservableLink({
  href,
  label,
  onClick,
  children,
  ...anchorProps
}: ObservableLinkProps) {
  const eventBus = useEventBus();

  // Store callback in ref to avoid including in dependency arrays
  const onClickRef = useRef(onClick);
  useEffect(() => {
    onClickRef.current = onClick;
  });

  const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    // Emit event for observability
    eventBus.get('navigation:link-clicked').next({
      href,
      label
    });

    // Call original onClick if provided
    onClickRef.current?.(e);
  }, [href, label]); // eventBus is global singleton - never in deps

  return (
    <a
      href={href}
      onClick={handleClick}
      {...anchorProps}
    >
      {children}
    </a>
  );
}
