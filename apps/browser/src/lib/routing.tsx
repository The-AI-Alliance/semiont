/**
 * Routing configuration for the Semiont Browser
 *
 * This module provides the concrete implementation of the RoutingContext
 * interface for this React Router application.
 */

import { Link as LocaleLink } from '@/i18n/routing';
import type { RouteBuilder, LinkComponentProps } from '@semiont/react-ui';

/**
 * react-ui components pass `href`; React Router's link takes `to`.
 *
 * A plain component, not `forwardRef`: no react-ui component hands its `Link`
 * a ref.
 */
export function Link({ href, ...props }: LinkComponentProps) {
  return <LocaleLink to={href} {...props} />;
}

/**
 * Route builder for the Semiont Browser
 */
export const routes: RouteBuilder = {
  resourceDetail: (id: string) => `/know/resource/${id}`,
  knowledge: () => '/know',
  moderate: () => '/moderate',
};
