/**
 * The first fault of a value as one of the spec's schemas, as every SDK names
 * it: the table generated from the spec (packages/codegen/schemas/required-shapes.mjs),
 * read as Go's is (packages/go/sdk/internal/required/required_test.go).
 */

import { describe, it, expect } from 'vitest';
import { faultOf, faultSaid, type Fault } from '../required';

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

describe('faultSaid', () => {
  it('says each fault as every SDK says it', () => {
    expect(faultSaid(lacks('representations.mediaType'))).toBe('it has no `representations.mediaType`');
    expect(faultSaid(malformed('representations'))).toBe('its `representations` is malformed');
    expect(faultSaid(malformed(''))).toBe('it is malformed');
  });
});
