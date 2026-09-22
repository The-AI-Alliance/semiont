import { describe, it, expect } from 'vitest';
import { errField } from '../logger';

/**
 * errField exists because Winston serializes an Error as `{}`. It must keep
 * everything the error carries — not only name/message/stack. An HTTP
 * client's error says just the status text in `message` and puts the server's
 * reply in own enumerable fields (`status`, `data`); dropping those is how a
 * Qdrant 422 once logged as a bare "Unprocessable Entity" with the rejected
 * field nowhere in sight.
 */
describe('errField', () => {
  it('keeps the fields an error carries beyond name, message, and stack', () => {
    class ApiError extends Error {
      status = 422;
      data = { status: { error: 'searches[0].internal.limit: value 0 invalid, must be 1 or larger' } };
    }

    const field = errField(new ApiError('Unprocessable Entity'));

    expect(field).toMatchObject({
      name: 'Error',
      message: 'Unprocessable Entity',
      status: 422,
      data: { status: { error: 'searches[0].internal.limit: value 0 invalid, must be 1 or larger' } },
    });
    expect(field).toHaveProperty('stack');
  });

  it('follows cause, serializing it the same way', () => {
    const inner = Object.assign(new Error('inner'), { code: 'ECONNREFUSED' });

    const field = errField(new Error('outer', { cause: inner })) as { cause: unknown };

    expect(field).toMatchObject({ message: 'outer', cause: { message: 'inner', code: 'ECONNREFUSED' } });
  });

  it('passes non-errors through unchanged', () => {
    expect(errField('just text')).toBe('just text');
    expect(errField({ reason: 'plain' })).toEqual({ reason: 'plain' });
    expect(errField(undefined)).toBeUndefined();
  });
});
