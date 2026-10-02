/**
 * The kinds of id, held to the cases every SDK runs
 * (specs/src/identifiers/kinds.json): each string a kind accepts makes a value
 * of its type and each it refuses throws. The constructors are generated from
 * the same table and each kind's schema, so nothing here or in core states
 * the rule a second time.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_SCOPE,
  annotationId,
  isAnnotationId,
  isJobId,
  isResourceId,
  isUserId,
  jobId,
  resourceId,
  userId,
  type AnnotationId,
  type JobId,
  type ResourceId,
  type UserId,
  type components,
} from '../index';

const SPEC = resolve(__dirname, '../../../../specs/src');

interface Kind {
  schema: string;
  accepts: Array<{ id: string; why: string }>;
  refuses: Array<{ id: string; why: string }>;
}

const { kinds } = JSON.parse(readFileSync(resolve(SPEC, 'identifiers/kinds.json'), 'utf8')) as { kinds: Kind[] };

/** Each kind's constructor and its guard. A kind the table names and this does not is a kind no test holds. */
const MAKES: Record<string, (value: string) => string> = {
  ResourceId: resourceId,
  AnnotationId: annotationId,
  JobId: jobId,
  UserId: userId,
};
const ASKS: Record<string, (value: string) => boolean> = {
  ResourceId: isResourceId,
  AnnotationId: isAnnotationId,
  JobId: isJobId,
  UserId: isUserId,
};

describe('the kinds of id', () => {
  it('every kind the spec names has a constructor here, and no other does', () => {
    expect(Object.keys(MAKES).sort()).toEqual(kinds.map((kind) => kind.schema).sort());
    expect(Object.keys(ASKS).sort()).toEqual(Object.keys(MAKES).sort());
  });

  for (const kind of kinds) {
    const make = MAKES[kind.schema]!;

    const asks = ASKS[kind.schema]!;

    it.each(kind.accepts)(`${kind.schema} accepts $id: $why`, ({ id }) => {
      expect(asks(id)).toBe(true);
      expect(make(id)).toBe(id);
    });

    it.each(kind.refuses)(`${kind.schema} refuses $id: $why`, ({ id }) => {
      expect(asks(id), 'asked, it is an answer and nothing is thrown').toBe(false);
      expect(() => make(id)).toThrow(TypeError);
      expect(() => make(id)).toThrow(`is not a ${kind.schema}`);
    });
  }

  it('the scope of the knowledge base\'s own events is a ResourceId', () => {
    expect(SYSTEM_SCOPE).toBe('__system__');
  });
});

describe('the types', () => {
  it('a property that carries an id is of its kind, and one kind is not another', () => {
    const resource: ResourceId = resourceId('res-one');
    const annotation: AnnotationId = annotationId('a-1');
    const job: JobId = jobId('job-1');
    const user: UserId = userId('did:web:kb.example:users:alice');

    // What the spec's types say is what the constructors make.
    const focus: components['schemas']['BeckonFocusEvent'] = { resourceId: resource, annotationId: annotation };
    const described: components['schemas']['ResourceDescriptor']['@id'] = resource;
    const metadata: Pick<components['schemas']['JobMetadata'], 'id' | 'userId'> = { id: job, userId: user };
    expect([focus.resourceId, described, metadata.id, metadata.userId]).toEqual(['res-one', 'res-one', 'job-1', user]);

    // Asked of text, the guard is what makes it an id.
    const entered: string = 'res-one';
    const narrowed: ResourceId | undefined = isResourceId(entered) ? entered : undefined;
    expect(narrowed).toBe('res-one');

    // @ts-expect-error text is not an id until its constructor has passed it
    const text: ResourceId = 'res-one';
    // @ts-expect-error an annotation's id is not a resource's
    const swapped: ResourceId = annotation;
    // @ts-expect-error nor in a payload
    const wrong: components['schemas']['BeckonFocusEvent'] = { resourceId: annotation };
    // @ts-expect-error a job's id is not whoever asked for it
    const mixed: UserId = job;
    expect([text, swapped, wrong.resourceId, mixed]).toHaveLength(4);
  });
});
