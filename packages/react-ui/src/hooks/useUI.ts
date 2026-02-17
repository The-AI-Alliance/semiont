'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hook for managing dropdown/menu visibility with click outside handling
 */
export function useDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => {
    setIsOpen(prev => !prev);
  }, []);

  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Handle click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        close();
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
    return undefined;
  }, [isOpen, close]);

  // Handle escape key
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        close();
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
    return undefined;
  }, [isOpen, close]);

  return {
    isOpen,
    toggle,
    open,
    close,
    dropdownRef,
  };
}

/**
 * Hook for managing loading states with minimum display time
 */
export function useLoadingState(minLoadingTime = 500) {
  const [isLoading, setIsLoading] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const startLoading = useCallback(() => {
    setIsLoading(true);
    setShowLoading(true);
  }, []);

  const stopLoading = useCallback(() => {
    setIsLoading(false);
    
    // Ensure loading is shown for minimum time
    timeoutRef.current = setTimeout(() => {
      setShowLoading(false);
    }, minLoadingTime);
  }, [minLoadingTime]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return {
    isLoading,
    showLoading,
    startLoading,
    stopLoading,
  };
}

/**
 * Hook for managing form validation states
 */
export function useFormValidation<T>(
  initialValues: T,
  validationFn: (values: T) => Record<keyof T, string | undefined>
) {
  const [values, setValues] = useState<T>(initialValues);
  const [errors, setErrors] = useState<Record<keyof T, string | undefined>>({} as Record<keyof T, string | undefined>);
  const [touched, setTouchedState] = useState<Record<keyof T, boolean>>({} as Record<keyof T, boolean>);

  const validate = useCallback(() => {
    const newErrors = validationFn(values);
    setErrors(newErrors);
    return Object.values(newErrors).every(error => !error);
  }, [values, validationFn]);

  const setValue = useCallback((field: keyof T, value: T[keyof T]) => {
    setValues(prev => ({
      ...prev,
      [field]: value,
    }));
  }, []);

  const setTouched = useCallback((field: keyof T, isTouched = true) => {
    setTouchedState(prev => ({
      ...prev,
      [field]: isTouched,
    }));
  }, []);

  const reset = useCallback(() => {
    setValues(initialValues);
    setErrors({} as Record<keyof T, string | undefined>);
    setTouchedState({} as Record<keyof T, boolean>);
  }, [initialValues]);

  // Validate on value changes
  useEffect(() => {
    const newErrors = validationFn(values);
    setErrors(newErrors);
  }, [values, validationFn]);

  return {
    values,
    errors,
    touched,
    setValue,
    setTouched,
    validate,
    reset,
    isValid: Object.values(errors).every(error => !error),
  };
}

/**
 * Hook for managing toast notifications
 */
export function useToast() {
  const [toasts, setToasts] = useState<Array<{
    id: string;
    message: string;
    type: 'success' | 'error' | 'warning' | 'info';
    duration?: number;
  }>>([]);

  const addToast = useCallback((
    message: string,
    type: 'success' | 'error' | 'warning' | 'info' = 'info',
    duration = 5000
  ) => {
    const id = Math.random().toString(36).slice(2);
    const toast = { id, message, type, duration };
    
    setToasts(prev => [...prev, toast]);

    // Auto remove after duration
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);

    return id;
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  return {
    toasts,
    addToast,
    removeToast,
    clearToasts,
    success: (message: string) => addToast(message, 'success'),
    error: (message: string) => addToast(message, 'error', 8000),
    warning: (message: string) => addToast(message, 'warning', 6000),
    info: (message: string) => addToast(message, 'info'),
  };
}

/**
 * Hook for local storage with SSR safety
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((val: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === 'undefined') {
      return initialValue;
    }

    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  const setValue = useCallback((value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(key, JSON.stringify(valueToStore));
      }
    } catch (error) {
      console.error(`Error setting localStorage key "${key}":`, error);
    }
  }, [key, storedValue]);

  return [storedValue, setValue];
}