import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useDropdown,
  useLoadingState,
  useFormValidation,
  useDebounce,
  useToast,
} from '../useUI';

// Following MSW v2 + Vitest + ESM strategy established in the codebase
describe('useUI Hooks', () => {
  describe('useDropdown', () => {
    let addEventListenerSpy: any;
    let removeEventListenerSpy: any;

    beforeEach(() => {
      addEventListenerSpy = vi.spyOn(document, 'addEventListener');
      removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('Initial State', () => {
      it('should initialize with closed state', () => {
        const { result } = renderHook(() => useDropdown());

        expect(result.current.isOpen).toBe(false);
        expect(result.current.dropdownRef.current).toBe(null);
      });
    });

    describe('State Management', () => {
      it('should toggle open/closed state', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.toggle();
        });
        expect(result.current.isOpen).toBe(true);

        act(() => {
          result.current.toggle();
        });
        expect(result.current.isOpen).toBe(false);
      });

      it('should open when open() called', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });
        expect(result.current.isOpen).toBe(true);
      });

      it('should close when close() called', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });
        expect(result.current.isOpen).toBe(true);

        act(() => {
          result.current.close();
        });
        expect(result.current.isOpen).toBe(false);
      });
    });

    describe('Event Handling', () => {
      it('should add event listeners when opened', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });

        expect(addEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
        expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
      });

      it('should remove event listeners when closed', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });

        act(() => {
          result.current.close();
        });

        expect(removeEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
        expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
      });

      it('should close on Escape key press', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });
        expect(result.current.isOpen).toBe(true);

        act(() => {
          const keydownEvent = new KeyboardEvent('keydown', { key: 'Escape' });
          document.dispatchEvent(keydownEvent);
        });
        expect(result.current.isOpen).toBe(false);
      });

      it('should not close on other key presses', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });

        act(() => {
          const keydownEvent = new KeyboardEvent('keydown', { key: 'Enter' });
          document.dispatchEvent(keydownEvent);
        });
        expect(result.current.isOpen).toBe(true);
      });

      it('should close on click outside dropdown', () => {
        const { result } = renderHook(() => useDropdown());

        const mockDropdownElement = document.createElement('div');
        (result.current.dropdownRef as any).current = mockDropdownElement;

        act(() => {
          result.current.open();
        });

        const outsideElement = document.createElement('div');
        document.body.appendChild(outsideElement);

        act(() => {
          const clickEvent = new MouseEvent('mousedown', { bubbles: true });
          Object.defineProperty(clickEvent, 'target', {
            writable: false,
            value: outsideElement,
          });
          document.dispatchEvent(clickEvent);
        });

        expect(result.current.isOpen).toBe(false);
        document.body.removeChild(outsideElement);
      });

      it('should not close on click inside dropdown', () => {
        const { result } = renderHook(() => useDropdown());

        const mockDropdownElement = document.createElement('div');
        const insideElement = document.createElement('button');
        mockDropdownElement.appendChild(insideElement);
        (result.current.dropdownRef as any).current = mockDropdownElement;

        act(() => {
          result.current.open();
        });

        act(() => {
          const clickEvent = new MouseEvent('mousedown', { bubbles: true });
          Object.defineProperty(clickEvent, 'target', {
            writable: false,
            value: insideElement,
          });
          document.dispatchEvent(clickEvent);
        });

        expect(result.current.isOpen).toBe(true);
      });
    });

    describe('Cleanup', () => {
      it('should clean up event listeners on unmount', () => {
        const { result, unmount } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });

        unmount();

        expect(removeEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
        expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
      });
    });
  });

  describe('useLoadingState', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('Initial State', () => {
      it('should initialize with loading false', () => {
        const { result } = renderHook(() => useLoadingState());

        expect(result.current.isLoading).toBe(false);
        expect(result.current.showLoading).toBe(false);
      });

      it('should accept custom minimum loading time', () => {
        const { result } = renderHook(() => useLoadingState(1000));

        act(() => {
          result.current.startLoading();
        });

        act(() => {
          result.current.stopLoading();
        });

        expect(result.current.showLoading).toBe(true);

        act(() => {
          vi.advanceTimersByTime(1000);
        });

        expect(result.current.showLoading).toBe(false);
      });
    });

    describe('Loading Workflow', () => {
      it('should start loading correctly', () => {
        const { result } = renderHook(() => useLoadingState());

        act(() => {
          result.current.startLoading();
        });

        expect(result.current.isLoading).toBe(true);
        expect(result.current.showLoading).toBe(true);
      });

      it('should stop loading after minimum time', () => {
        const { result } = renderHook(() => useLoadingState(500));

        act(() => {
          result.current.startLoading();
        });

        act(() => {
          result.current.stopLoading();
        });

        expect(result.current.isLoading).toBe(false);
        expect(result.current.showLoading).toBe(true);

        act(() => {
          vi.advanceTimersByTime(500);
        });

        expect(result.current.showLoading).toBe(false);
      });

      it('should handle multiple cycles', () => {
        const { result } = renderHook(() => useLoadingState(100));

        // First cycle
        act(() => {
          result.current.startLoading();
        });

        act(() => {
          result.current.stopLoading();
        });

        act(() => {
          vi.advanceTimersByTime(100);
        });

        expect(result.current.showLoading).toBe(false);

        // Second cycle
        act(() => {
          result.current.startLoading();
        });

        expect(result.current.showLoading).toBe(true);
      });
    });

    describe('Cleanup', () => {
      it('should clear timeout on unmount', () => {
        const { result, unmount } = renderHook(() => useLoadingState(500));

        act(() => {
          result.current.startLoading();
          result.current.stopLoading();
        });

        unmount();

        act(() => {
          vi.advanceTimersByTime(500);
        });
        // Should not cause errors after unmount
      });
    });
  });

  describe('useFormValidation', () => {
    interface TestForm {
      name: string;
      email: string;
      age: number;
    }

    const initialValues: TestForm = {
      name: '',
      email: '',
      age: 0,
    };

    const validationFn = (values: TestForm): Record<keyof TestForm, string | undefined> => ({
      name: values.name.length < 2 ? 'Name must be at least 2 characters' : undefined,
      email: !values.email.includes('@') ? 'Invalid email format' : undefined,
      age: values.age < 18 ? 'Must be 18 or older' : undefined,
    });

    describe('Initial State', () => {
      it('should initialize with provided values and automatic validation', async () => {
        const { result } = renderHook(() =>
          useFormValidation(initialValues, validationFn)
        );

        expect(result.current.values).toEqual(initialValues);
        expect(result.current.touched).toEqual({});
        
        // Validation runs automatically via useEffect
        await waitFor(() => {
          expect(result.current.errors).toEqual({
            name: 'Name must be at least 2 characters',
            email: 'Invalid email format',
            age: 'Must be 18 or older',
          });
        });
        
        expect(result.current.isValid).toBe(false);
      });
    });

    describe('Value Management', () => {
      it('should update values correctly', async () => {
        const { result } = renderHook(() =>
          useFormValidation(initialValues, validationFn)
        );

        await act(async () => {
          result.current.setValue('name', 'John Doe');
        });

        expect(result.current.values.name).toBe('John Doe');
        
        await waitFor(() => {
          expect(result.current.errors.name).toBeUndefined();
        });
      });

      it('should update touched state', () => {
        const { result } = renderHook(() =>
          useFormValidation(initialValues, validationFn)
        );

        act(() => {
          result.current.setTouched('name');
        });

        expect(result.current.touched.name).toBe(true);

        act(() => {
          result.current.setTouched('email', false);
        });

        expect(result.current.touched.email).toBe(false);
      });
    });

    describe('Validation', () => {
      it('should validate automatically on value changes', async () => {
        const { result } = renderHook(() =>
          useFormValidation(initialValues, validationFn)
        );

        // Wait for initial validation
        await waitFor(() => {
          expect(result.current.errors.name).toBe('Name must be at least 2 characters');
        });

        await act(async () => {
          result.current.setValue('name', 'J'); // 1 character - still invalid
        });

        // After setValue, the error should still be present since 'J' is still too short
        await waitFor(() => {
          expect(result.current.errors.name).toBe('Name must be at least 2 characters');
        });

        await act(async () => {
          result.current.setValue('name', 'John Doe'); // Now valid
        });

        await waitFor(() => {
          expect(result.current.errors.name).toBeUndefined();
        });
      });

      it('should return validation result from validate function', async () => {
        const { result } = renderHook(() =>
          useFormValidation(
            { name: 'John Doe', email: 'john@example.com', age: 25 },
            validationFn
          )
        );

        let isValid: boolean;
        await act(async () => {
          isValid = result.current.validate();
        });

        expect(isValid!).toBe(true);
        expect(result.current.isValid).toBe(true);
      });

      it('should handle complex validation scenarios', async () => {
        const { result } = renderHook(() =>
          useFormValidation(initialValues, validationFn)
        );

        await act(async () => {
          result.current.setValue('name', 'John Doe');
          result.current.setValue('email', 'john@example.com');
          result.current.setValue('age', 25);
        });

        await waitFor(() => {
          expect(result.current.isValid).toBe(true);
          expect(result.current.errors.name).toBeUndefined();
          expect(result.current.errors.email).toBeUndefined();
          expect(result.current.errors.age).toBeUndefined();
        });
      });
    });

    describe('Reset Functionality', () => {
      it('should reset to initial values', async () => {
        const { result } = renderHook(() =>
          useFormValidation(initialValues, validationFn)
        );

        await act(async () => {
          result.current.setValue('name', 'John');
          result.current.setTouched('name');
        });

        await act(async () => {
          result.current.reset();
        });

        expect(result.current.values).toEqual(initialValues);
        expect(result.current.touched).toEqual({});
        
        // After reset, validation runs again on initial values
        await waitFor(() => {
          expect(result.current.errors).toEqual({
            name: 'Name must be at least 2 characters',
            email: 'Invalid email format',
            age: 'Must be 18 or older',
          });
        });
      });
    });
  });

  describe('useDebounce', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('Basic Functionality', () => {
      it('should return initial value immediately', () => {
        const { result } = renderHook(() => useDebounce('initial', 500));
        expect(result.current).toBe('initial');
      });

      it('should debounce value changes', () => {
        const { result, rerender } = renderHook(
          ({ value, delay }) => useDebounce(value, delay),
          { initialProps: { value: 'initial', delay: 500 } }
        );

        expect(result.current).toBe('initial');

        rerender({ value: 'updated', delay: 500 });
        expect(result.current).toBe('initial');

        act(() => {
          vi.advanceTimersByTime(500);
        });

        expect(result.current).toBe('updated');
      });

      it('should cancel previous debounce on rapid changes', () => {
        const { result, rerender } = renderHook(
          ({ value, delay }) => useDebounce(value, delay),
          { initialProps: { value: 'initial', delay: 500 } }
        );

        rerender({ value: 'first', delay: 500 });
        rerender({ value: 'second', delay: 500 });
        rerender({ value: 'final', delay: 500 });

        expect(result.current).toBe('initial');

        act(() => {
          vi.advanceTimersByTime(500);
        });

        expect(result.current).toBe('final');
      });

      it('should work with different data types', () => {
        const { result: stringResult } = renderHook(() => useDebounce('string', 100));
        const { result: numberResult } = renderHook(() => useDebounce(42, 100));
        const { result: objectResult } = renderHook(() => useDebounce({ key: 'value' }, 100));

        expect(typeof stringResult.current).toBe('string');
        expect(typeof numberResult.current).toBe('number');
        expect(typeof objectResult.current).toBe('object');
      });
    });

    describe('Cleanup', () => {
      it('should clear timeout on unmount', () => {
        const { rerender, unmount } = renderHook(
          ({ value, delay }) => useDebounce(value, delay),
          { initialProps: { value: 'initial', delay: 500 } }
        );

        rerender({ value: 'updated', delay: 500 });
        unmount();

        act(() => {
          vi.advanceTimersByTime(500);
        });
        // Should not cause errors after unmount
      });
    });
  });

  describe('useToast', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('Initial State', () => {
      it('should initialize with empty toasts', () => {
        const { result } = renderHook(() => useToast());
        expect(result.current.toasts).toEqual([]);
      });
    });

    describe('Adding Toasts', () => {
      it('should add toast with default settings', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.addToast('Test message');
        });

        expect(result.current.toasts).toHaveLength(1);
        expect(result.current.toasts[0]).toMatchObject({
          id: expect.any(String),
          message: 'Test message',
          type: 'info',
          duration: 5000,
        });
      });

      it('should add toast with custom settings', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.addToast('Error message', 'error', 3000);
        });

        expect(result.current.toasts[0]).toMatchObject({
          message: 'Error message',
          type: 'error',
          duration: 3000,
        });
      });

      it('should auto-remove toast after duration', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.addToast('Test message', 'info', 1000);
        });

        expect(result.current.toasts).toHaveLength(1);

        act(() => {
          vi.advanceTimersByTime(1000);
        });

        expect(result.current.toasts).toHaveLength(0);
      });

      it('should add multiple toasts', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.addToast('First toast');
          result.current.addToast('Second toast');
        });

        expect(result.current.toasts).toHaveLength(2);
      });
    });

    describe('Convenience Methods', () => {
      it('should add success toast', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.success('Success message');
        });

        expect(result.current.toasts[0]).toMatchObject({
          message: 'Success message',
          type: 'success',
        });
      });

      it('should add error toast with extended duration', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.error('Error message');
        });

        expect(result.current.toasts[0]).toMatchObject({
          message: 'Error message',
          type: 'error',
        });

        act(() => {
          vi.advanceTimersByTime(7999);
        });
        expect(result.current.toasts).toHaveLength(1);

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(result.current.toasts).toHaveLength(0);
      });

      it('should add warning and info toasts', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.warning('Warning message');
          result.current.info('Info message');
        });

        expect(result.current.toasts).toHaveLength(2);
        expect(result.current.toasts[0]!.type).toBe('warning');
        expect(result.current.toasts[1]!.type).toBe('info');
      });
    });

    describe('Manual Toast Management', () => {
      it('should remove specific toast by id', () => {
        const { result } = renderHook(() => useToast());

        let toastId: string;
        act(() => {
          toastId = result.current.addToast('Test message');
          result.current.addToast('Another message');
        });

        expect(result.current.toasts).toHaveLength(2);

        act(() => {
          result.current.removeToast(toastId);
        });

        expect(result.current.toasts).toHaveLength(1);
        expect(result.current.toasts[0]!.message).toBe('Another message');
      });

      it('should clear all toasts', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.addToast('First');
          result.current.addToast('Second');
          result.current.addToast('Third');
        });

        expect(result.current.toasts).toHaveLength(3);

        act(() => {
          result.current.clearToasts();
        });

        expect(result.current.toasts).toHaveLength(0);
      });
    });

    describe('Toast ID Generation', () => {
      it('should generate unique IDs', () => {
        const { result } = renderHook(() => useToast());

        let id1: string = '';
        let id2: string = '';
        act(() => {
          id1 = result.current.addToast('First');
          id2 = result.current.addToast('Second');
        });

        expect(id1).not.toBe(id2);
        expect(result.current.toasts[0]!.id).toBe(id1);
        expect(result.current.toasts[1]!.id).toBe(id2);
      });
    });
  });
});