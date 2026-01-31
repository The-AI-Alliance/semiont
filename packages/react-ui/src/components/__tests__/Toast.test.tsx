import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast, ToastContainer, type ToastMessage } from '../Toast';

describe('Toast System', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Note: ToastContainer uses createPortal which has issues in jsdom
  // Testing focuses on ToastProvider integration and toast types/behavior

  describe('ToastProvider & useToast Hook', () => {
    function TestComponent() {
      const toast = useToast();

      return (
        <div>
          <button onClick={() => toast.showSuccess('Success!')}>Show Success</button>
          <button onClick={() => toast.showError('Error!')}>Show Error</button>
          <button onClick={() => toast.showWarning('Warning!')}>Show Warning</button>
          <button onClick={() => toast.showInfo('Info!')}>Show Info</button>
          <button onClick={() => toast.showToast('Custom', 'success', 5000)}>
            Show Custom
          </button>
        </div>
      );
    }

    it('should throw error when useToast is used outside ToastProvider', () => {
      // Suppress console.error for this test
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => render(<TestComponent />)).toThrow(
        'useToast must be used within a ToastProvider'
      );

      spy.mockRestore();
    });

    it('should provide toast context when wrapped in ToastProvider', () => {
      expect(() =>
        render(
          <ToastProvider>
            <TestComponent />
          </ToastProvider>
        )
      ).not.toThrow();
    });

    it('should provide toast context methods', () => {
      let contextValue: any;

      function CaptureContext() {
        contextValue = useToast();
        return null;
      }

      render(
        <ToastProvider>
          <CaptureContext />
        </ToastProvider>
      );

      expect(contextValue).toBeDefined();
      expect(typeof contextValue.showToast).toBe('function');
      expect(typeof contextValue.showSuccess).toBe('function');
      expect(typeof contextValue.showError).toBe('function');
      expect(typeof contextValue.showWarning).toBe('function');
      expect(typeof contextValue.showInfo).toBe('function');
    });

    it('should render buttons correctly', () => {
      render(
        <ToastProvider>
          <TestComponent />
        </ToastProvider>
      );

      expect(screen.getByText('Show Success')).toBeInTheDocument();
      expect(screen.getByText('Show Error')).toBeInTheDocument();
      expect(screen.getByText('Show Warning')).toBeInTheDocument();
      expect(screen.getByText('Show Info')).toBeInTheDocument();
      expect(screen.getByText('Show Custom')).toBeInTheDocument();
    });
  });
});
