import { vi } from 'vitest';

/**
 * Create a mock Anthropic response with text content
 */
export function createMockTextResponse(text: string) {
  return {
    id: 'msg_test123',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text,
      },
    ],
    model: 'claude-3-5-sonnet-20241022',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 20,
    },
  };
}

/**
 * Create a mock Anthropic response with no text content
 */
export function createMockEmptyResponse() {
  return {
    id: 'msg_test123',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-3-5-sonnet-20241022',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 0,
    },
  };
}

/**
 * Create a mock Anthropic response with multiple content blocks
 */
export function createMockMultiBlockResponse(texts: string[]) {
  return {
    id: 'msg_test123',
    type: 'message',
    role: 'assistant',
    content: texts.map(text => ({
      type: 'text',
      text,
    })),
    model: 'claude-3-5-sonnet-20241022',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 20,
    },
  };
}

/**
 * Create a mock Anthropic client
 */
export function createMockAnthropicClient(mockResponse: any = createMockTextResponse('Mock response')) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue(mockResponse),
    },
  };
}

/**
 * Create a mock Anthropic client that throws an error
 */
export function createMockAnthropicClientWithError(error: Error) {
  return {
    messages: {
      create: vi.fn().mockRejectedValue(error),
    },
  };
}
