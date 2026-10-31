/**
 * What a value lacks to be one of the spec's schemas, as every SDK names it:
 * the table generated from the spec (scripts/spec/required-members.mjs), read
 * as Go's is (packages/go/sdk/internal/required/required_test.go).
 */

import { describe, it, expect } from 'vitest';
import { memberLacking } from '../required';

describe('memberLacking', () => {
  it("is the way to what a value lacks of what its schema requires, wherever it is", () => {
    for (const [text, lacks] of [
      ['{"@id":"r","name":"n","representations":[]}', '@context'],
      ['{"@context":"c","@id":"r","name":"n","representations":[]}', undefined],
      ['{"@context":"c","@id":"r","name":null,"representations":[]}', 'name'],
      ['{"@context":"c","@id":"r","name":"n","representations":"text"}', undefined],
      ['{"@context":"c","@id":"r","name":"n","representations":{}}', 'representations.mediaType'],
      ['{"@context":"c","@id":"r","name":"n","representations":[{}]}', 'representations.mediaType'],
      ['{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":{"@type":"Organization"}}', 'wasAttributedTo.name'],
      ['{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":[{"@type":"Person"},{"@type":"Organization"}]}', 'wasAttributedTo.name'],
      ['{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":{"@type":"Person"}}', undefined],
      ['"a resource"', undefined],
    ] as const) {
      expect(memberLacking('ResourceDescriptor', JSON.parse(text)), text).toBe(lacks);
    }
  });

  it('lets a member that may be null hold null, and still requires it', () => {
    const user = { did: 'did:web:example.org:users:a', domain: 'example.org', email: null, name: null, image: null };
    expect(memberLacking('UserResponse', user)).toBeUndefined();
    expect(memberLacking('UserResponse', { ...user, image: undefined })).toBe('image');
  });

  it('holds a value to each part of a composite, and each value of a map', () => {
    expect(memberLacking('GatherFailed', { message: 'no context' })).toBe('annotationId');
    expect(memberLacking('BrowseProfilesResult', { response: { profiles: { 'did:web:example.org:users:a': {} } } })).toBe('response.profiles.name');
  });
});
