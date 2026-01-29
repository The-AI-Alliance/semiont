import { vi } from 'vitest';

/**
 * Shared mock for Anthropic SDK messages.create
 * Each test file must call setupAnthropicMock() at the top level
 */
export const mockCreate = vi.fn();

/**
 * Setup function to be called from each test file
 * Must be called BEFORE any imports of factory.ts
 */
export function setupAnthropicMock() {
  vi.mock('@anthropic-ai/sdk', () => {
    return {
      default: vi.fn().mockImplementation((config: any) => ({
        apiKey: config?.apiKey,
        baseURL: config?.baseURL,
        messages: {
          create: mockCreate,
        },
      })),
    };
  });
}
