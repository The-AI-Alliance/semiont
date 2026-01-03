import React, { createContext, useContext } from 'react';

/**
 * Standard Link component interface
 * Compatible with Next.js Link, React Router Link, etc.
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
}

/**
 * Routing context type
 */
export interface RoutingContextType {
  /** Link component (Next.js Link, React Router Link, etc.) */
  Link: React.ComponentType<LinkComponentProps>;

  /** Route builder for generating URLs */
  routes: RouteBuilder;
}

const RoutingContext = createContext<RoutingContextType | null>(null);

/**
 * Provider for routing configuration
 *
 * @example
 * ```tsx
 * import { Link } from 'next/link';
 * import { RoutingProvider } from '@semiont/react-ui';
 *
 * const routes = {
 *   resourceDetail: (id) => `/know/resource/${id}`,
 *   userProfile: (id) => `/users/${id}`,
 *   search: (query) => `/search?q=${query}`,
 *   home: () => '/',
 * };
 *
 * <RoutingProvider value={{ Link, routes }}>
 *   <App />
 * </RoutingProvider>
 * ```
 */
export function RoutingProvider({
  children,
  value
}: {
  children: React.ReactNode;
  value: RoutingContextType;
}) {
  return (
    <RoutingContext.Provider value={value}>
      {children}
    </RoutingContext.Provider>
  );
}

/**
 * Hook to access routing configuration
 *
 * @throws {Error} If used outside RoutingProvider
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { Link, routes } = useRouting();
 *
 *   return (
 *     <Link href={routes.resourceDetail('123')}>
 *       View Resource
 *     </Link>
 *   );
 * }
 * ```
 */
export function useRouting(): RoutingContextType {
  const context = useContext(RoutingContext);

  if (!context) {
    throw new Error(
      'useRouting must be used within a RoutingProvider. ' +
      'Wrap your app with <RoutingProvider> to provide routing configuration.'
    );
  }

  return context;
}
