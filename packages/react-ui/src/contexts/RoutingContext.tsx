'use client';

import React from 'react';

/**
 * Standard Link component interface
 * Compatible with Next.js Link, React Router Link, etc.
 *
 * Components accept Link as a prop to remain framework-agnostic.
 * Apps provide their framework-specific Link component (Next.js, React Router, etc.)
 */
export interface LinkComponentProps {
  href: string;
  children: React.ReactNode;
  className?: string;
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
  [key: string]: any; // Allow additional props for framework-specific links
}

/**
 * Route builder interface
 * Apps provide concrete implementations for their routing scheme
 *
 * Components accept routes as a prop to build URLs without framework dependencies.
 *
 * @example
 * ```tsx
 * // In the app (apps/browser/src/lib/routing.tsx)
 * export const routes: RouteBuilder = {
 *   resourceDetail: (id) => `/know/resource/${id}`,
 *   knowledge: () => '/know',
 *   moderate: () => '/moderate',
 * };
 *
 * // Pass to components as props
 * <MyComponent Link={Link} routes={routes} />
 * ```
 */
export interface RouteBuilder {
  /** Resource detail page */
  resourceDetail: (id: string) => string;

  /** Knowledge base page */
  knowledge?: () => string;

  /** Moderation dashboard */
  moderate?: () => string;
}
