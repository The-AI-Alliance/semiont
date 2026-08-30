/**
 * Log Sanitization Utilities
 *
 * Ensures sensitive data is never logged by mistake.
 * Masks passwords, tokens, API keys, and other sensitive fields.
 */

// Fields that should never be logged
const SENSITIVE_FIELDS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
  'sessionId',
  'creditCard',
  'ssn',
  'privateKey',
  'clientSecret'
];

// Fields that should be partially masked (show first/last few chars)
const PARTIAL_MASK_FIELDS = [
  'email',
  'phone',
  'userId',
  'accountId'
];

/**
 * Sanitize an object for logging by removing or masking sensitive fields
 *
 * @param data - The data to sanitize
 * @param options - Sanitization options
 * @returns Sanitized copy of the data
 */
export function sanitizeForLogging<T>(
  data: T,
  options: {
    maskValue?: string;
    partialMask?: boolean;
    additionalSensitiveFields?: string[];
  } = {}
): T {
  const {
    maskValue = '[REDACTED]',
    partialMask = true,
    additionalSensitiveFields = []
  } = options;

  const allSensitiveFields = [
    ...SENSITIVE_FIELDS,
    ...additionalSensitiveFields
  ].map(f => f.toLowerCase());

  function sanitize(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(sanitize);
    }

    const sanitized: any = {};

    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();

      // Check if field should be completely masked
      if (allSensitiveFields.some(field => lowerKey.includes(field))) {
        sanitized[key] = maskValue;
      }
      // Check if field should be partially masked
      else if (partialMask && PARTIAL_MASK_FIELDS.some(field => lowerKey.includes(field))) {
        sanitized[key] = partialMaskValue(value);
      }
      // Recursively sanitize nested objects
      else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitize(value);
      }
      // Keep non-sensitive values as-is
      else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  return sanitize(data);
}

/**
 * Partially mask a value (show first 3 and last 2 characters)
 */
function partialMaskValue(value: any): string {
  if (typeof value !== 'string' || value.length <= 6) {
    return '[MASKED]';
  }

  const firstChars = value.substring(0, 3);
  const lastChars = value.substring(value.length - 2);
  const maskLength = Math.max(value.length - 5, 3);
  const mask = '*'.repeat(maskLength);

  return `${firstChars}${mask}${lastChars}`;
}

/**
 * Create a safe logging context by sanitizing all data
 *
 * @param context - The logging context
 * @returns Sanitized context safe for logging
 */
export function createSafeLogContext(context: Record<string, any>): Record<string, any> {
  return sanitizeForLogging(context, {
    partialMask: true
  });
}

/**
 * Sanitize HTTP headers for logging
 * Removes authorization, cookie, and other sensitive headers
 */
export function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const sanitized: Record<string, string | string[] | undefined> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    if (lowerKey === 'authorization' || lowerKey === 'cookie' || lowerKey === 'x-api-key') {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}