/**
 * Routing configuration for Semiont frontend
 *
 * This module provides the concrete implementation of the RoutingContext
 * interface for the React Router-based frontend application.
 */

import React from 'react';
import { Link as NextLink } from '@/i18n/routing';
import type { RouteBuilder, LinkComponentProps } from '@semiont/react-ui';
import type { ComponentType } from 'react';

/**
 * Adapter: react-ui components pass `href`, but React Router Link expects `to`.
 */
const LinkAdapter = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(
  function LinkAdapter({ href, ...props }, ref) {
    return <NextLink ref={ref} to={href} {...props} />;
  }
);
export const Link: ComponentType<LinkComponentProps> = LinkAdapter as any;

/**
 * Route builder for Semiont frontend
 */
export const routes: RouteBuilder = {
  resourceDetail: (id: string) => `/know/resource/${id}`,
  userProfile: (id: string) => `/users/${id}`,
  search: (query: string) => `/search?q=${encodeURIComponent(query)}`,
  home: () => '/',
  about: () => '/about',
  privacy: () => '/privacy',
  terms: () => '/terms',
  knowledge: () => '/know',
  moderate: () => '/moderate',
  admin: () => '/admin',
};
