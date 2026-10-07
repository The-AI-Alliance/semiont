import { describe, it, expect } from 'vitest';
import { resourceId } from '@semiont/core';
import { isHeldMark } from '../types';

/**
 * The spec leaves the params of a held job open, so a holder learns which of
 * the five `mark` jobs it was handed by asking. The answer is only yes for
 * params that holder can run.
 */
describe('isHeldMark', () => {
  const R = resourceId('res-1');
  const schema = { id: 'irac', name: 'IRAC', description: 'Legal analysis', domain: 'legal', tags: [] };

  it('is yes for the motivation the params state, and no for any other', () => {
    const params = { resourceId: R, motivation: 'commenting', tone: 'scholarly' };
    expect(isHeldMark(params, 'commenting')).toBe(true);
    expect(isHeldMark(params, 'assessing')).toBe(false);
  });

  it('is no for params that state no motivation: a yield job\'s', () => {
    expect(isHeldMark({ resourceId: R, title: 'Ouranos', storageUri: 'file://generated/ouranos.md' }, 'highlighting')).toBe(false);
  });

  it('takes a tagging job only with the schema the Dispatcher resolved', () => {
    const asked = { resourceId: R, motivation: 'tagging', schemaId: 'irac', categories: ['Issue'] };
    expect(isHeldMark(asked, 'tagging'), 'a schemaId alone is the request, and names a schema this holder cannot read').toBe(false);
    expect(isHeldMark({ ...asked, schema }, 'tagging')).toBe(true);
  });
});
