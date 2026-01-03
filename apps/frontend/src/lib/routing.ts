/**
 * Next.js routing configuration for Semiont frontend
 *
 * This module provides the concrete implementation of the RoutingContext
 * interface for the Next.js-based frontend application.
 */

import { Link as NextLink } from '@/i18n/routing';
import type { RouteBuilder, LinkComponentProps } from '@semiont/react-ui';
import type { ComponentType } from 'react';

/**
 * Next.js Link component wrapper
 * Ensures compatibility with react-ui's LinkComponentProps interface
 */
export const Link: ComponentType<LinkComponentProps> = NextLink as any;

/**
 * Route builder for Semiont frontend
 * Implements the RouteBuilder interface with Next.js App Router paths
 */
export const routes: RouteBuilder = {
  /**
   * Resource detail page
   * @param id - Resource ID
   * @returns Path to resource detail page
   */
  resourceDetail: (id: string) => `/know/resource/${id}`,

  /**
   * User profile page
   * @param id - User ID
   * @returns Path to user profile page
   */
  userProfile: (id: string) => `/users/${id}`,

  /**
   * Search page with query
   * @param query - Search query string
   * @returns Path to search page with encoded query parameter
   */
  search: (query: string) => `/search?q=${encodeURIComponent(query)}`,

  /**
   * Home/root page
   * @returns Path to home page
   */
  home: () => '/',
};
