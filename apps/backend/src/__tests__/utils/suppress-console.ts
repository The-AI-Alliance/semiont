/**
 * Utility for suppressing console output in tests that intentionally generate errors
 */

/**
 * Suppresses console.error for the duration of a function call
 * Useful for tests that intentionally trigger errors to verify error handling
 */
export function suppressConsoleError<T>(fn: () => T): T {
  const originalConsoleError = console.error;
  console.error = () => {}; // Suppress
  
  try {
    return fn();
  } finally {
    console.error = originalConsoleError; // Restore
  }
}

/**
 * Suppresses console.error for the duration of an async function call
 * Useful for tests that intentionally trigger errors to verify error handling
 */
export async function suppressConsoleErrorAsync<T>(fn: () => Promise<T>): Promise<T> {
  const originalConsoleError = console.error;
  console.error = () => {}; // Suppress
  
  try {
    return await fn();
  } finally {
    console.error = originalConsoleError; // Restore
  }
}