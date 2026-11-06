/**
 * The first fault of a value as one of the spec's schemas, as every SDK names
 * it: the table generated from the spec (packages/codegen/schemas/required-shapes.mjs),
 * read as Go's is (packages/go/sdk/internal/required/required_test.go).
 */

import { describe, it, expect } from 'vitest';
import { faultOf, faultOfShape, said, type Fault, type Shape } from '../required';

const lacks = (member: string): Fault => ({ member, reason: 'lacks' });
const malformed = (member: string): Fault => ({ member, reason: 'malformed' });

describe('faultOf', () => {
  it('is the first member a value lacks, or the first of a kind its schema does not allow, wherever it is', () => {
    for (const [text, fault] of [
      ['{"@id":"r","name":"n","representations":[]}', lacks('@context')],
      ['{"@context":"c","@id":"r","name":"n","representations":[]}', undefined],
      ['{"@context":"c","@id":"r","name":null,"representations":[]}', lacks('name')],
      ['{"@context":"c","@id":"r","name":7,"representations":[]}', malformed('name')],
      ['{"@context":"c","@id":"r","name":"n","representations":"text"}', malformed('representations')],
      ['{"@context":"c","@id":"r","name":"n","representations":[null]}', malformed('representations')],
      ['{"@context":"c","@id":"r","name":"n","representations":{}}', lacks('representations.mediaType')],
      ['{"@context":"c","@id":"r","name":"n","representations":[{}]}', lacks('representations.mediaType')],
      ['{"@context":"c","@id":"r","name":"n","representations":[{"mediaType":"text/plain","byteSize":1.5}]}', malformed('representations.byteSize')],
      ['{"@context":"c","@id":"r","name":"n","representations":[{"mediaType":"text/plain","byteSize":2.0}]}', undefined],
      ['{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":{"@type":"Organization"}}', lacks('wasAttributedTo.name')],
      ['{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":[{"@type":"Person"},{"@type":"Organization"}]}', lacks('wasAttributedTo.name')],
      ['{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":{"@type":"Person"}}', undefined],
      ['{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":"a person"}', malformed('wasAttributedTo')],
      ['{"@context":1998,"@id":"r","representations":[]}', lacks('name')],
      ['"a resource"', malformed('')],
    ] as const) {
      expect(faultOf('ResourceDescriptor', JSON.parse(text)), text).toEqual(fault);
    }
  });

  it('lets a member that may be null hold null, and still requires it', () => {
    const user = { did: 'did:web:example.org:users:a', domain: 'example.org', email: null, name: null, image: null };
    expect(faultOf('UserResponse', user)).toBeUndefined();
    expect(faultOf('UserResponse', { ...user, image: undefined })).toEqual(lacks('image'));
    expect(faultOf('UserResponse', { ...user, image: 5 })).toEqual(malformed('image'));
  });

  it('holds a value to each part of a composite, and each value of a map', () => {
    expect(faultOf('GatherFailed', { message: 'no context' })).toEqual(lacks('annotationId'));
    expect(faultOf('BrowseProfilesResult', { response: { profiles: { 'did:web:example.org:users:a': {} } } })).toEqual(lacks('response.profiles.name'));
    expect(faultOf('BrowseProfilesResult', { response: { profiles: { 'did:web:example.org:users:a': null } } })).toEqual(malformed('response.profiles'));
  });
});

describe('faultOfShape', () => {
  const faultsAs = (shape: Shape, cases: readonly (readonly [string, Fault | undefined])[]): void => {
    for (const [text, fault] of cases) expect(faultOfShape(shape, JSON.parse(text)), text).toEqual(fault);
  };

  it('holds a value to its values, its form and its size', () => {
    faultsAs({ kinds: ['string', 'integer'], enum: ['mark', 2] }, [
      ['"mark"', undefined],
      ['2.0', undefined],
      ['"yield"', malformed('')],
      ['3', malformed('')],
    ]);
    const anyThenDigits: Shape = {
      kinds: ['string', 'null'],
      pattern: [
        { of: [[0, 9], [11, 12], [14, 8231], [8234, 1114111]], min: 1 },
        { of: [[45, 45]], min: 1, max: 1 },
        { of: [[48, 57]], min: 1 },
      ],
    };
    faultsAs(anyThenDigits, [
      ['"p-a-1-2"', undefined],
      ['"\\ud83d\\ude00-1"', undefined],
      ['null', undefined],
      ['"p-"', malformed('')],
      ['"\\n-1"', malformed('')],
    ]);
    faultsAs({ kinds: ['string'], minLength: 2, maxLength: 3 }, [
      ['"\\ud83d\\ude00\\ud83d\\ude00"', undefined],
      ['"\\ud83d\\ude00"', malformed('')],
      ['"abcd"', malformed('')],
    ]);
    faultsAs({ kinds: ['number'], minimum: 0, maximum: 1 }, [
      ['0', undefined],
      ['1', undefined],
      ['-0.5', malformed('')],
      ['1.5', malformed('')],
    ]);
    faultsAs({ kinds: ['array'], minItems: 1, maxItems: 2 }, [
      ['[1]', undefined],
      ['[]', malformed('')],
      ['[1,2,3]', malformed('')],
    ]);
  });

  it('refuses a member a closed object does not name, after the members it describes, the first by code point', () => {
    faultsAs({ kinds: ['object'], required: ['a'], members: { a: { kinds: ['string'] } }, closed: ['a'] }, [
      ['{"a":"x"}', undefined],
      ['{"b":1}', lacks('a')],
      ['{"a":1,"b":1}', malformed('a')],
      ['{"a":"x","z":1,"b":1}', malformed('b')],
      ['{"a":"x","\\ud83d\\ude00":1,"\\uff61":1}', malformed('\uff61')],
    ]);
    faultsAs({ kinds: ['object'], closed: [] }, [
      ['{}', undefined],
      ['{"x":1}', malformed('x')],
    ]);
  });
});

describe('said', () => {
  it('says each fault as every SDK says it', () => {
    expect(said(lacks('representations.mediaType'))).toBe('it has no `representations.mediaType`');
    expect(said(malformed('representations'))).toBe('its `representations` is malformed');
    expect(said(malformed(''))).toBe('it is malformed');
  });
});
