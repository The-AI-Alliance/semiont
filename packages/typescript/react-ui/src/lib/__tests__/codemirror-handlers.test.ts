import { describe, it, expect, vi, afterEach } from 'vitest';
import { annotationId, resourceId, type Annotation } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { createTestSession } from '@semiont/sdk/testing';
import {
  handleAnnotationClick,
  handleWidgetClick,
  dispatchWidgetClick,
  handleWidgetMouseEnter,
  handleWidgetMouseLeave,
} from '../codemirror-handlers';
import type { WidgetClickResult } from '../codemirror-handlers';
import type { TextSegment } from '../codemirror-logic';

function makeSegment(id: string, motivation: Annotation['motivation']): TextSegment {
  return {
    exact: 'test',
    start: 0,
    end: 4,
    annotation: {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      type: 'Annotation',
      id: annotationId(id),
      motivation,
      target: resourceId('res-1'),
      created: '2026-01-01T00:00:00Z',
    },
  };
}

const sessions: SemiontSession[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) {
    session.dispose();
    session.client.dispose();
  }
});

/** A real session, and spies on the two browse verbs the handlers send. */
function makeSession() {
  const { session, client } = createTestSession();
  sessions.push(session);
  const click = vi.spyOn(client.browse, 'click').mockImplementation(() => {});
  const openResource = vi.spyOn(client.browse, 'openResource').mockImplementation(() => {});
  return { session, click, openResource };
}

// DOM helper: create element with data attributes
function createElement(tag: string, attrs: Record<string, string> = {}, parent?: HTMLElement): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  if (parent) parent.appendChild(el);
  return el;
}

describe('handleAnnotationClick', () => {
  it('returns false when target has no annotation-id', () => {
    const target = document.createElement('span');
    const result = handleAnnotationClick(target, new Map(), makeSession().session);
    expect(result).toBe(false);
  });

  it('returns false when annotation not in segments map', () => {
    const parent = createElement('span', { 'data-annotation-id': 'missing' });
    const child = createElement('span', {}, parent);
    const result = handleAnnotationClick(child, new Map(), makeSession().session);
    expect(result).toBe(false);
  });

  it('emits browse:click and returns true for valid annotation', () => {
    const segmentsById = new Map<string, TextSegment>();
    segmentsById.set('ann-1', makeSegment('ann-1', 'highlighting'));

    const parent = createElement('span', { 'data-annotation-id': 'ann-1' });
    const child = createElement('span', {}, parent);
    const { session, click } = makeSession();

    const result = handleAnnotationClick(child, segmentsById, session);
    expect(result).toBe(true);
    expect(click).toHaveBeenCalledWith('ann-1');
  });
});

describe('handleWidgetClick', () => {
  it('returns handled:false when no widget ancestor', () => {
    const target = document.createElement('span');
    expect(handleWidgetClick(target).handled).toBe(false);
  });

  it('returns handled:false when widget is generating', () => {
    const widget = createElement('div', {
      class: 'reference-preview-widget',
      'data-widget-generating': 'true',
      'data-widget-annotation-id': 'ann-1',
    });
    expect(handleWidgetClick(widget).handled).toBe(false);
  });

  it('returns handled:false when no annotation id', () => {
    const widget = createElement('div', { class: 'reference-preview-widget' });
    expect(handleWidgetClick(widget).handled).toBe(false);
  });

  it('returns navigate action for resolved reference', () => {
    const widget = createElement('div', {
      class: 'reference-preview-widget',
      'data-widget-annotation-id': 'ann-1',
      'data-widget-body-source': 'doc-123',
      'data-widget-resolved': 'true',
    });
    const result = handleWidgetClick(widget);
    expect(result).toEqual({
      handled: true,
      action: 'navigate',
      resourceId: 'doc-123',
      annotationId: 'ann-1',
    });
  });

  it('returns browse-click action for unresolved reference', () => {
    const widget = createElement('div', {
      class: 'reference-preview-widget',
      'data-widget-annotation-id': 'ann-1',
      'data-widget-motivation': 'linking',
    });
    const result = handleWidgetClick(widget);
    expect(result).toEqual({
      handled: true,
      action: 'browse-click',
      annotationId: 'ann-1',
    });
  });

});

describe('dispatchWidgetClick', () => {
  it('does nothing when not handled', () => {
    const { session, click, openResource } = makeSession();
    dispatchWidgetClick({ handled: false }, session);
    expect(click).not.toHaveBeenCalled();
    expect(openResource).not.toHaveBeenCalled();
  });

  it('emits browse:resource-open for navigate action', () => {
    const { session, openResource } = makeSession();
    const result: WidgetClickResult = {
      handled: true,
      action: 'navigate',
      resourceId: 'doc-1',
      annotationId: 'ann-1',
    };
    dispatchWidgetClick(result, session);
    expect(openResource).toHaveBeenCalledWith('doc-1');
  });

  it('emits browse:click for browse-click action', () => {
    const { session, click } = makeSession();
    const result: WidgetClickResult = {
      handled: true,
      action: 'browse-click',
      annotationId: 'ann-1',
    };
    dispatchWidgetClick(result, session);
    expect(click).toHaveBeenCalledWith('ann-1');
  });
});

describe('handleWidgetMouseEnter', () => {
  it('returns showPreview:false when no widget', () => {
    const target = document.createElement('span');
    const result = handleWidgetMouseEnter(target);
    expect(result.showPreview).toBe(false);
    expect(result.widget).toBeNull();
  });

  it('returns showPreview:false when widget is generating', () => {
    const widget = createElement('div', {
      class: 'reference-preview-widget',
      'data-widget-generating': 'true',
    });
    expect(handleWidgetMouseEnter(widget).showPreview).toBe(false);
  });

  it('returns showPreview:true with targetName for resolved reference', () => {
    const widget = createElement('div', {
      class: 'reference-preview-widget',
      'data-widget-resolved': 'true',
      'data-widget-target-name': 'My Doc',
    });
    const result = handleWidgetMouseEnter(widget);
    expect(result.showPreview).toBe(true);
    expect(result.targetName).toBe('My Doc');
    expect(result.widget).toBe(widget);
  });

  it('raises indicator opacity', () => {
    const widget = createElement('div', { class: 'reference-preview-widget' });
    const indicator = createElement('span', { class: 'reference-indicator' }, widget);
    handleWidgetMouseEnter(widget);
    expect(indicator.style.opacity).toBe('1');
  });
});

describe('handleWidgetMouseLeave', () => {
  it('returns hidePreview:false when no widget', () => {
    const target = document.createElement('span');
    const result = handleWidgetMouseLeave(target);
    expect(result.hidePreview).toBe(false);
    expect(result.widget).toBeNull();
  });

  it('returns hidePreview:true for resolved widget', () => {
    const widget = createElement('div', {
      class: 'reference-preview-widget',
      'data-widget-resolved': 'true',
    });
    const result = handleWidgetMouseLeave(widget);
    expect(result.hidePreview).toBe(true);
    expect(result.widget).toBe(widget);
  });

  it('lowers indicator opacity', () => {
    const widget = createElement('div', { class: 'reference-preview-widget' });
    const indicator = createElement('span', { class: 'reference-indicator' }, widget);
    handleWidgetMouseLeave(widget);
    expect(indicator.style.opacity).toBe('0.6');
  });
});
