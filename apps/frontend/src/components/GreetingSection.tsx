'use client';

import { useState, useMemo } from 'react';
import { NameInputSchema, sanitizeInput, validateData } from '@/lib/validation';
import { useDebounce } from '@/hooks/useUI';
import { useGreeting } from '@/hooks/useAPI';
import { useAuth } from '@/hooks/useAuth';

export function GreetingSection() {
  const [name, setName] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const { isFullyAuthenticated } = useAuth();
  
  // Debounce the name input to avoid excessive API calls
  const debouncedName = useDebounce(name, 300);
  
  // Validate and sanitize name for API call
  const validatedName = useMemo(() => {
    if (!debouncedName) return undefined;
    
    const validation = validateData(NameInputSchema, debouncedName);
    if (validation.success) {
      setValidationError(null);
      return validation.data;
    } else {
      setValidationError(validation.error);
      return undefined;
    }
  }, [debouncedName]);
  
  // Use custom hook for greeting API
  const greeting = useGreeting(validatedName);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target.value;
    
    // Basic XSS prevention - limit characters during typing
    const cleaned = input.replace(/[^a-zA-Z0-9\s\-']/g, '');
    
    if (cleaned !== input) {
      setValidationError('Special characters are not allowed');
    } else {
      setValidationError(null);
    }
    
    setName(cleaned);
  };

  // Show authentication message if not fully authenticated
  if (!isFullyAuthenticated) {
    return (
      <section className="p-8 bg-gray-100 dark:bg-gray-800 rounded-lg" aria-labelledby="greeting-section-title">
        <h2 id="greeting-section-title" className="sr-only">Personal Greeting</h2>
        <p className="text-gray-600 dark:text-gray-400">
          Please sign in to use the greeting feature.
        </p>
      </section>
    );
  }

  return (
    <section className="p-8 bg-gray-100 dark:bg-gray-800 rounded-lg" aria-labelledby="greeting-section-title">
      <h2 id="greeting-section-title" className="sr-only">Personal Greeting</h2>
      <div className="mb-4">
        <label htmlFor="name-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Enter your name to receive a personalized greeting
        </label>
        <input
          id="name-input"
          type="text"
          placeholder="Enter your name"
          value={name}
          onChange={handleNameChange}
          className={`w-full px-4 py-2 rounded-md border ${
            validationError 
              ? 'border-red-500 focus:ring-red-500' 
              : 'border-gray-300 dark:border-gray-600 focus:ring-blue-500'
          } bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:border-transparent transition-colors`}
          maxLength={50}
          aria-invalid={!!validationError}
          aria-describedby={validationError ? 'name-error' : 'name-instructions'}
          autoComplete="given-name"
        />
        {!validationError && (
          <p id="name-instructions" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Only letters, numbers, spaces, hyphens, and apostrophes are allowed
          </p>
        )}
        {validationError && (
          <p id="name-error" className="mt-1 text-sm text-red-600 dark:text-red-400" role="alert">
            {validationError}
          </p>
        )}
      </div>
      
      {validatedName && greeting.data ? (
        <div role="region" aria-live="polite" aria-label="Greeting response">
          <h3 className="text-2xl font-semibold mb-2">
            {/* Sanitize output even though it comes from our API */}
            {sanitizeInput(greeting.data.message)}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            <span className="sr-only">Generated on </span>
            {greeting.data.platform} • {new Date(greeting.data.timestamp).toLocaleString()}
          </p>
        </div>
      ) : null}

      {validatedName && greeting.isLoading ? (
        <div className="text-gray-500 dark:text-gray-400" role="status" aria-live="polite">
          <span className="sr-only">Loading, please wait</span>
          Loading greeting...
        </div>
      ) : null}

      {validatedName && greeting.error ? (
        <div className="text-red-600 dark:text-red-400" role="alert" aria-live="polite">
          Failed to load greeting. Please try again.
        </div>
      ) : null}
    </section>
  );
}