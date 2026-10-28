/**
 * The image overlay's hover: a shape the pointer rests on is said to be
 * hovered, and a rest still in flight when the overlay unmounts says nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { Annotation, AnnotationId } from '@semiont/core';
import { resourceId } from '@semiont/core';
import { AnnotationOverlay } from '../AnnotationOverlay';

const rectAnnotation: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'img-ann-1' as AnnotationId,
  type: 'Annotation',
  motivation: 'highlighting',
  created: '2024-01-01T10:00:00Z',
  target: {
    source: resourceId('resource-1'),
    selector: { type: 'SvgSelector', value: '<svg><rect x="10" y="10" width="20" height="20"/></svg>' },
  },
};

function sessionDouble() {
  const hover = vi.fn();
  const session = { client: { browse: { click: vi.fn() }, beckon: { hover } } } as unknown as SemiontSession;
  return { session, hover };
}

function overlay(session: SemiontSession) {
  return (
    <AnnotationOverlay
      annotations={[rectAnnotation]}
      imageWidth={100}
      imageHeight={100}
      displayWidth={200}
      displayHeight={200}
      session={session}
      hoverDelayMs={100}
    />
  );
}

describe('AnnotationOverlay — hover', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('says a shape is hovered once the pointer has rested on it, and none when it leaves', () => {
    const { session, hover } = sessionDouble();
    const { container } = render(overlay(session));
    const shape = container.querySelector('.semiont-annotation-overlay__shape');
    expect(shape).toBeInTheDocument();

    fireEvent.mouseEnter(shape!);
    vi.advanceTimersByTime(100);
    fireEvent.mouseLeave(shape!);

    expect(hover.mock.calls).toEqual([['img-ann-1'], [null]]);
  });

  it('says nothing for a rest still in flight when it unmounts', () => {
    const { session, hover } = sessionDouble();
    const { container, unmount } = render(overlay(session));

    fireEvent.mouseEnter(container.querySelector('.semiont-annotation-overlay__shape')!);
    unmount();
    vi.advanceTimersByTime(200);

    expect(hover).not.toHaveBeenCalled();
  });
});
