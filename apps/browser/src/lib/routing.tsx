/**
 * Routing configuration for Semiont frontend
 *
 * This module provides the concrete implementation of the RoutingContext
 * interface for the React Router-based frontend application.
 */

import { Link as LocaleLink } from '@/i18n/routing';
import type { RouteBuilder, LinkComponentProps } from '@semiont/react-ui';

/**
 * react-ui components pass `href`; React Router's link takes `to`.
 *
 * A plain component, not `forwardRef`: no react-ui component hands its `Link`
 * a ref, and `forwardRef` wraps the props in `Omit<…, 'ref'>`, which over
 * `LinkComponentProps`'s index signature drops `href` and `children` — the
 * mismatch an `as any` used to paper over.
 */
export function Link({ href, ...props }: LinkComponentProps) {
  return <LocaleLink to={href} {...props} />;
}

/**
 * Route builder for Semiont frontend
 */
export const routes: RouteBuilder = {
  resourceDetail: (id: string) => `/know/resource/${id}`,
  knowledge: () => '/know',
  moderate: () => '/moderate',
};
