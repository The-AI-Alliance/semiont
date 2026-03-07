import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { ApiClientProvider, useApiClient } from '../ApiClientContext';
import { SemiontApiClient } from '@semiont/api-client';

// Test component that uses the hook
function TestConsumer() {
  const client = useApiClient();

  return (
    <div>
      <div data-testid="client-status">{client ? 'has-client' : 'no-client'}</div>
      <div data-testid="client-type">{client ? client.constructor.name : 'null'}</div>
    </div>
  );
}

describe('ApiClientContext', () => {
  describe('ApiClientProvider', () => {
    it('should provide API client to child components', () => {
      render(
        <ApiClientProvider baseUrl="https://api.example.com">
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('has-client');
      expect(screen.getByTestId('client-type')).toHaveTextContent('SemiontApiClient');
    });

    it('should render children', () => {
      render(
        <ApiClientProvider baseUrl="https://api.example.com">
          <div data-testid="child">Child content</div>
        </ApiClientProvider>
      );

      expect(screen.getByTestId('child')).toHaveTextContent('Child content');
    });

    it('should update when baseUrl changes', () => {
      const { rerender } = render(
        <ApiClientProvider baseUrl="https://api.example.com">
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('has-client');

      rerender(
        <ApiClientProvider baseUrl="https://api2.example.com">
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toHaveTextContent('has-client');
    });
  });

  describe('useApiClient', () => {
    it('should throw error when used outside provider', () => {
      const consoleError = console.error;
      console.error = () => {};

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useApiClient must be used within an ApiClientProvider');

      console.error = consoleError;
    });

    it('should return client from context', () => {
      render(
        <ApiClientProvider baseUrl="https://api.example.com">
          <TestConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('client-status')).toBeInTheDocument();
    });

    it('should return a SemiontApiClient instance', () => {
      function TypeCheckConsumer() {
        const client = useApiClient();
        return <div data-testid="is-instance">{client instanceof SemiontApiClient ? 'true' : 'false'}</div>;
      }

      render(
        <ApiClientProvider baseUrl="https://api.example.com">
          <TypeCheckConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('is-instance')).toHaveTextContent('true');
    });
  });

  describe('Provider Pattern Integration', () => {
    it('should work with nested providers', () => {
      function InnerConsumer() {
        const client = useApiClient();
        return (
          <div data-testid="inner-status">{client ? 'has-client' : 'no-client'}</div>
        );
      }

      function OuterConsumer() {
        const client = useApiClient();
        return (
          <div>
            <div data-testid="outer-status">{client ? 'has-client' : 'no-client'}</div>
            <ApiClientProvider baseUrl="https://inner.api.com">
              <InnerConsumer />
            </ApiClientProvider>
          </div>
        );
      }

      render(
        <ApiClientProvider baseUrl="https://outer.api.com">
          <OuterConsumer />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('outer-status')).toHaveTextContent('has-client');
      expect(screen.getByTestId('inner-status')).toHaveTextContent('has-client');
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple components using same client', () => {
      function Consumer1() {
        const client = useApiClient();
        return <div data-testid="consumer1">{client ? 'has-client' : 'no-client'}</div>;
      }

      function Consumer2() {
        const client = useApiClient();
        return <div data-testid="consumer2">{client ? 'has-client' : 'no-client'}</div>;
      }

      render(
        <ApiClientProvider baseUrl="https://api.example.com">
          <Consumer1 />
          <Consumer2 />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('consumer1')).toHaveTextContent('has-client');
      expect(screen.getByTestId('consumer2')).toHaveTextContent('has-client');
    });

    it('should handle conditional rendering of components', () => {
      function ConditionalConsumer({ show }: { show: boolean }) {
        const client = useApiClient();
        if (!show) return null;
        return <div data-testid="conditional">{client ? 'shown' : 'hidden'}</div>;
      }

      const { rerender } = render(
        <ApiClientProvider baseUrl="https://api.example.com">
          <ConditionalConsumer show={false} />
        </ApiClientProvider>
      );

      expect(screen.queryByTestId('conditional')).not.toBeInTheDocument();

      rerender(
        <ApiClientProvider baseUrl="https://api.example.com">
          <ConditionalConsumer show={true} />
        </ApiClientProvider>
      );

      expect(screen.getByTestId('conditional')).toHaveTextContent('shown');
    });
  });
});
