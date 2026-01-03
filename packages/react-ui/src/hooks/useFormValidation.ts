import { useState, useCallback } from 'react';
import { useLiveRegion } from '../components/LiveRegion';

interface ValidationError {
  field: string;
  message: string;
}

interface UseFormValidationOptions {
  announceErrors?: boolean;
}

export function useFormValidation(options: UseFormValidationOptions = {}) {
  const { announceErrors = true } = options;
  const { announce } = useLiveRegion();
  const [errors, setErrors] = useState<Record<string, string>>({});

  const setFieldError = useCallback((field: string, message: string) => {
    setErrors(prev => ({ ...prev, [field]: message }));

    if (announceErrors) {
      // Announce error to screen readers
      announce(`Error in ${field}: ${message}`, 'assertive');
    }
  }, [announceErrors, announce]);

  const clearFieldError = useCallback((field: string) => {
    setErrors(prev => {
      const newErrors = { ...prev };
      delete newErrors[field];
      return newErrors;
    });
  }, []);

  const clearAllErrors = useCallback(() => {
    setErrors({});
  }, []);

  const validateField = useCallback(
    (field: string, value: any, rules: Record<string, (value: any) => string | null>) => {
      for (const [ruleName, validator] of Object.entries(rules)) {
        const errorMessage = validator(value);
        if (errorMessage) {
          setFieldError(field, errorMessage);
          return false;
        }
      }
      clearFieldError(field);
      return true;
    },
    [setFieldError, clearFieldError]
  );

  const announceSuccess = useCallback((message: string) => {
    announce(message, 'polite');
  }, [announce]);

  const getFieldError = useCallback((field: string) => {
    return errors[field] || null;
  }, [errors]);

  const hasErrors = useCallback(() => {
    return Object.keys(errors).length > 0;
  }, [errors]);

  return {
    errors,
    setFieldError,
    clearFieldError,
    clearAllErrors,
    validateField,
    announceSuccess,
    getFieldError,
    hasErrors,
  };
}

// Common validation rules
export const validationRules = {
  required: (message = 'This field is required') => (value: any) => {
    if (!value || (typeof value === 'string' && !value.trim())) {
      return message;
    }
    return null;
  },

  minLength: (min: number, message?: string) => (value: string) => {
    if (value && value.length < min) {
      return message || `Must be at least ${min} characters`;
    }
    return null;
  },

  maxLength: (max: number, message?: string) => (value: string) => {
    if (value && value.length > max) {
      return message || `Must be no more than ${max} characters`;
    }
    return null;
  },

  email: (message = 'Please enter a valid email address') => (value: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (value && !emailRegex.test(value)) {
      return message;
    }
    return null;
  },

  url: (message = 'Please enter a valid URL') => (value: string) => {
    try {
      if (value) {
        new URL(value);
      }
    } catch {
      return message;
    }
    return null;
  },

  pattern: (regex: RegExp, message: string) => (value: string) => {
    if (value && !regex.test(value)) {
      return message;
    }
    return null;
  },
};