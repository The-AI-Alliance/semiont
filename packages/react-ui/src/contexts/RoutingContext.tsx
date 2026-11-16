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
 * // In app (e.g., frontend/src/lib/routing.ts)
 * export const routes: RouteBuilder = {
 *   resourceDetail: (id) => `/know/resource/${id}`,
 *   userProfile: (id) => `/users/${id}`,
 *   search: (query) => `/search?q=${query}`,
 *   home: () => '/',
 * };
 *
 * // Pass to components as props
 * <MyComponent Link={Link} routes={routes} />
 * ```
 */
export interface RouteBuilder {
  /** Resource detail page */
  resourceDetail: (id: string) => string;

  /** User profile page */
  userProfile: (id: string) => string;

  /** Search page with query */
  search: (query: string) => string;

  /** Home/root page */
  home: () => string;

  /** About page */
  about?: () => string;

  /** Privacy policy page */
  privacy?: () => string;

  /** Terms of service page */
  terms?: () => string;

  /** Knowledge base page */
  knowledge?: () => string;

  /** Moderation dashboard */
  moderate?: () => string;

  /** Admin dashboard */
  admin?: () => string;
}
