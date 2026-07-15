/**
 * A1 anchor thread (HEADLESS-ANNOTATION-PANELS Phase 3) — image overlay pin.
 *
 * The overlay's shape elements own their on-screen geometry: a click passes
 * the element's viewport rect as browse.click's third argument so hosts can
 * anchor popovers. Runtime-only view geometry; no schema involvement.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { Annotation, AnnotationId } from '@semiont/core';
import { AnnotationOverlay } from '../AnnotationOverlay';

const rectAnnotation: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'img-ann-1' as AnnotationId,
  type: 'Annotation',
  motivation: 'highlighting',
  created: '2024-01-01T10:00:00Z',
  target: {
    source: 'resource-1',
    selector: {
      type: 'SvgSelector',
      value: '<svg><rect x="10" y="10" width="20" height="20"/></svg>',
    },
  },
};

function sessionDouble() {
  const click = vi.fn();
  const session = {
    client: {
      browse: { click },
      beckon: { hover: vi.fn() },
    },
  } as unknown as SemiontSession;
  return { session, click };
}

describe('AnnotationOverlay — anchorRect on click', () => {
  it('passes the shape element rect as browse.click third argument', () => {
    const { session, click } = sessionDouble();

    const { container } = render(
      <AnnotationOverlay
        annotations={[rectAnnotation]}
        imageWidth={100}
        imageHeight={100}
        displayWidth={200}
        displayHeight={200}
        session={session}
        hoverDelayMs={0}
      />,
    );

    const shape = container.querySelector('.semiont-annotation-overlay__shape');
    expect(shape).toBeInTheDocument();

    fireEvent.click(shape!);

    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.calls[0]?.[0]).toBe('img-ann-1');
    expect(click.mock.calls[0]?.[1]).toBe('highlighting');
    const anchorRect = click.mock.calls[0]?.[2];
    expect(anchorRect).toBeDefined();
    expect(typeof anchorRect.width).toBe('number');
    expect(typeof anchorRect.left).toBe('number');
  });
});
