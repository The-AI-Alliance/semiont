/**
 * assembleAnnotation — RESOURCE-LEVEL-ANCHOR P2.
 *
 * The target selector is optional: a source-only target annotates the whole
 * resource (resource-level edges, whole-resource notes), per W3C. These pin the
 * removal of the old "Either TextPositionSelector, SvgSelector, or
 * FragmentSelector is required" throw, while keeping the SVG-markup and
 * motivation guards.
 */
import { describe, it, expect } from 'vitest';
import { assembleAnnotation } from '../annotation-assembly';
import type { components } from '../types';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type Agent = components['schemas']['Agent'];

const agent: Agent = { '@type': 'Person', '@id': 'did:web:test.local:users:tester', name: 'Tester' };

describe('assembleAnnotation — selector-optional target (P2)', () => {
  it('assembles a source-only target (whole-resource / edge) without throwing', () => {
    const request: CreateAnnotationRequest = {
      motivation: 'linking',
      target: { source: 'http://localhost:4000/resources/r-1' },
    };
    const { annotation } = assembleAnnotation(request, agent);
    // target stored verbatim — selector-less
    expect(annotation.target).toEqual({ source: 'http://localhost:4000/resources/r-1' });
    expect(annotation.motivation).toBe('linking');
    expect(annotation.id).toBeTruthy();
    expect(annotation.creator).toEqual(agent);
  });

  it('still assembles a target with a selector (no regression)', () => {
    const request: CreateAnnotationRequest = {
      motivation: 'highlighting',
      target: {
        source: 'http://localhost:4000/resources/r-1',
        selector: { type: 'TextPositionSelector', start: 0, end: 5 },
      },
    };
    const { annotation } = assembleAnnotation(request, agent);
    expect(annotation.target).toMatchObject({ selector: { type: 'TextPositionSelector', start: 0, end: 5 } });
  });

  it('still rejects invalid SvgSelector markup when a selector IS present', () => {
    const request: CreateAnnotationRequest = {
      motivation: 'highlighting',
      target: {
        source: 'http://localhost:4000/resources/r-1',
        selector: { type: 'SvgSelector', value: '<not-svg></not-svg>' },
      },
    };
    expect(() => assembleAnnotation(request, agent)).toThrow(/Invalid SVG markup/);
  });

  it('still requires motivation', () => {
    // @ts-expect-error — deliberately omitting required motivation to exercise the runtime guard
    const request: CreateAnnotationRequest = { target: { source: 'http://localhost:4000/resources/r-1' } };
    expect(() => assembleAnnotation(request, agent)).toThrow(/motivation is required/);
  });
});
