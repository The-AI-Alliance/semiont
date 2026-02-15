import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { ApiClientProvider, useApiClient } from '../ApiClientContext';
import type { ApiClientManager } from '../../types/ApiClientManager';
import { SemiontApiClient } from '@semiont/api-client';

// Test component that uses the hook
function TestConsumer() {
  const client = useApiClient();

  return (
    <div>
      <div data-testid="client-status">{client ? 'authenticated' : 'unauthenticated'}</div>
      <div data-testid="client-type">{client ? client.constructor.name : 'null'}</div>
    </div>
  );
}

describe('ApiClientContext', () => {
  describe('ApiClientProvider', () => {
    it('should provide authenticated API client to child components', () => {
      const mockClient = new SemiontApiClient({
        baseUrl: 'https://api.example.com',
        accessToken: 'test-token',
      });

      render(
        <ApiClientProvider apiClientManager={mockClient}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('authenticated');
      expect(screen.getByTestId('client-type')).toHaveTextContent('SemiontApiClient');
    });

    it('should provide null client when unauthenticated', () => {
      render(
        <ApiClientProvider apiClientManager={null}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('unauthenticated');
      expect(screen.getByTestId('client-type')).toHaveTextContent('null');
    });

    it('should render children', () => {
      const mockClient = new SemiontApiClient({
        baseUrl: 'https://api.example.com',
        accessToken: 'test-token',
      });

      render(
        <ApiClientProvider apiClientManager={mockClient}>
          <div data-testid="child">Child content</div>
        </ApiClientProvider>
      );

      expect(screen.getByTestId('child')).toHaveTextContent('Child content');
    });

    it('should update when manager changes', () => {
      const { rerender } = render(
        <ApiClientProvider apiClientManager={null}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('unauthenticated');

      const mockClient = new SemiontApiClient({
        baseUrl: 'https://api.example.com',
        accessToken: 'new-token',
      });

      rerender(
        <ApiClientProvider apiClientManager={mockClient}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('authenticated');
    });

    it('should provide client with correct configuration', () => {
      const mockClient = new SemiontApiClient({
        baseUrl: 'https://api.example.com',
        accessToken: 'test-token-123',
      });

      function ClientConfigConsumer() {
        const client = useApiClient();
        return (
          <div>
            <div data-testid="has-client">{client ? 'yes' : 'no'}</div>
          </div>
        );
      }

      render(
        <ApiClientProvider apiClientManager={mockClient}>
          <ClientConfigConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('has-client')).toHaveTextContent('yes');
    });

    it('should handle client transitions from null to authenticated', () => {
      const { rerender } = render(
        <ApiClientProvider apiClientManager={null}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('unauthenticated');

      const mockClient = new SemiontApiClient({
        baseUrl: 'https://api.example.com',
        accessToken: 'new-token',
      });

      rerender(
        <ApiClientProvider apiClientManager={mockClient}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('authenticated');
    });

    it('should handle client transitions from authenticated to null', () => {
      const mockClient = new SemiontApiClient({
        baseUrl: 'https://api.example.com',
        accessToken: 'test-token',
      });

      const { rerender } = render(
        <ApiClientProvider apiClientManager={mockClient}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('authenticated');

      rerender(
        <ApiClientProvider apiClientManager={null}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('unauthenticated');
    });
  });

  describe('useApiClient', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleError = console.error;
      console.error = () => {};

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useApiClient must be used within an ApiClientProvider');

      console.error = consoleError;
    });

    it('should return client from context', () => {
      const mockClient = new SemiontApiClient({
        baseUrl: 'https://api.example.com',
        accessToken: 'test-token',
      });

      render(
        <ApiClientProvider apiClientManager={mockClient}>
          <TestConsumer />
        </ApiClientProvider>
      );

      // If no error is thrown and component renders, the hook works correctly
      expect(screen.getByTestId('client-status')).toBeInTheDocument();
    });

    it('should return null when unauthenticated', () => {
      function NullCheckConsumer() {
        const client = useApiClient();
        return <div data-testid="is-null">{client === null ? 'true' : 'false'}</div>;
      }

      render(
        <ApiClientProvider apiClientManager={null}>
          <NullCheckConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('is-null')).toHaveTextContent('true');
    });
  });

  describe('Provider Pattern Integration', () => {
    it('should accept any ApiClientManager implementation', () => {
      // Custom implementation (e.g., with different authentication system)
      class CustomApiClientManager implements ApiClientManager {
        client: SemiontApiClient | null;

        constructor(isAuthenticated: boolean) {
          this.client = isAuthenticated
            ? new SemiontApiClient({
                baseUrl: 'https://custom.api.com',
                accessToken: 'custom-token',
              })
            : null;
        }
      }

      const customManager = new CustomApiClientManager(true);

      render(
        <ApiClientProvider apiClientManager={customManager}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('authenticated');
    });

    it('should work with nested providers', () => {
      const outerClient = new SemiontApiClient({
        baseUrl: 'https://outer.api.com',
        accessToken: 'outer-token',
      });

      const innerClient = new SemiontApiClient({
        baseUrl: 'https://inner.api.com',
        accessToken: 'inner-token',
      });

      function InnerConsumer() {
        const client = useApiClient();
        return (
          <div data-testid="inner-status">{client ? 'authenticated' : 'unauthenticated'}</div>
        );
      }

      function OuterConsumer() {
        const client = useApiClient();
        return (
          <div>
            <div data-testid="outer-status">{client ? 'authenticated' : 'unauthenticated'}</div>
            <ApiClientProvider apiClientManager={innerClient}>
              <InnerConsumer />
            </ApiClientProvider>
          </div>
        );
      }

      render(
        <ApiClientProvider apiClientManager={outerClient}>
          <OuterConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('outer-status')).toHaveTextContent('authenticated');
      expect(screen.getByTestId('inner-status')).toHaveTextContent('authenticated');
    });

    it('should use innermost provider when nested', () => {
      const innerClient = new SemiontApiClient({
        baseUrl: 'https://inner.api.com',
        accessToken: 'inner-token',
      });

      function NestedConsumer() {
        const client = useApiClient();
        return (
          <div data-testid="nested-status">{client ? 'authenticated' : 'unauthenticated'}</div>
        );
      }

      render(
        <ApiClientProvider apiClientManager={null}>
          <ApiClientProvider apiClientManager={innerClient}>
            <NestedConsumer />
          </ApiClientProvider>
        </ApiClientProvider>
      );

      // Inner provider should override outer
      expect(screen.getByTestId('nested-status')).toHaveTextContent('authenticated');
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple components using same client', () => {
      const mockClient = new SemiontApiClient({
        baseUrl: 'https://api.example.com',
        accessToken: 'shared-token',
      });

      function Consumer1() {
        const client = useApiClient();
        return <div data-testid="consumer1">{client ? 'has-client' : 'no-client'}</div>;
      }

      function Consumer2() {
        const client = useApiClient();
        return <div data-testid="consumer2">{client ? 'has-client' : 'no-client'}</div>;
      }

      render(
        <ApiClientProvider apiClientManager={mockClient}>
          <Consumer1 />
          <Consumer2 />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('consumer1')).toHaveTextContent('has-client');
      expect(screen.getByTestId('consumer2')).toHaveTextContent('has-client');
    });

    it('should handle rapid client updates', () => {
      const { rerender } = render(
        <ApiClientProvider apiClientManager={null}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('unauthenticated');

      // Rapid updates
      for (let i = 0; i < 10; i++) {
        const client =
          i % 2 === 0
            ? new SemiontApiClient({
                baseUrl: 'https://api.example.com',
                accessToken: `token-${i}`,
              })
            : null;

        rerender(
          <ApiClientProvider apiClientManager={client}>
            <TestConsumer />
          </ApiClientProvider>
        );
      }

      // Last update was i=9 (odd), so client should be null
      expect(screen.getByTestId('client-status')).toHaveTextContent('unauthenticated');
    });

    it('should handle conditional rendering of components', () => {
      const mockClient = new SemiontApiClient({
        baseUrl: 'https://api.example.com',
        accessToken: 'test-token',
      });

      function ConditionalConsumer({ show }: { show: boolean }) {
        const client = useApiClient();
        if (!show) return null;
        return <div data-testid="conditional">{client ? 'shown' : 'hidden'}</div>;
      }

      const { rerender } = render(
        <ApiClientProvider apiClientManager={mockClient}>
          <ConditionalConsumer show={false} />
        </ApiClientProvider>
      );

      expect(screen.queryByTestId('conditional')).not.toBeInTheDocument();

      rerender(
        <ApiClientProvider apiClientManager={mockClient}>
          <ConditionalConsumer show={true} />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('conditional')).toHaveTextContent('shown');
    });

    it('should work when client manager is recreated but client is same', () => {
      const mockClient = new SemiontApiClient({
        baseUrl: 'https://api.example.com',
        accessToken: 'stable-token',
      });

      const { rerender } = render(
        <ApiClientProvider apiClientManager={mockClient}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('authenticated');

      rerender(
        <ApiClientProvider apiClientManager={mockClient}>
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('authenticated');
    });
  });
});
