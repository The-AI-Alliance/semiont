import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleAnnotationClick,
  handleWidgetClick,
  dispatchWidgetClick,
  handleWidgetMouseEnter,
  handleWidgetMouseLeave,
} from '../codemirror-handlers';
import type { WidgetClickResult } from '../codemirror-handlers';
import type { TextSegment } from '../codemirror-logic';

function makeSegment(id: string, motivation: string): TextSegment {
  return {
    exact: 'test',
    start: 0,
    end: 4,
    annotation: { id, motivation } as any,
  };
}

function makeEventBus() {
  const subjects: Record<string, { next: ReturnType<typeof vi.fn> }> = {};
  return {
    get: vi.fn((name: string) => {
      if (!subjects[name]) subjects[name] = { next: vi.fn() };
      return subjects[name]!;
    }),
    subjects,
  } as any;
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
    const result = handleAnnotationClick(target, new Map(), makeEventBus());
    expect(result).toBe(false);
  });

  it('returns false when annotation not in segments map', () => {
    const parent = createElement('span', { 'data-annotation-id': 'missing' });
    const child = createElement('span', {}, parent);
    const result = handleAnnotationClick(child, new Map(), makeEventBus());
    expect(result).toBe(false);
  });

  it('emits browse:click and returns true for valid annotation', () => {
    const segmentsById = new Map<string, TextSegment>();
    segmentsById.set('ann-1', makeSegment('ann-1', 'highlighting'));

    const parent = createElement('span', { 'data-annotation-id': 'ann-1' });
    const child = createElement('span', {}, parent);
    const eventBus = makeEventBus();

    const result = handleAnnotationClick(child, segmentsById, eventBus);
    expect(result).toBe(true);
    expect(eventBus.get).toHaveBeenCalledWith('browse:click');
    expect(eventBus.subjects['browse:click']!.next).toHaveBeenCalledWith({
      annotationId: 'ann-1',
      motivation: 'highlighting',
    });
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
      documentId: 'doc-123',
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
      motivation: 'linking',
    });
  });

  it('defaults motivation to linking when not set', () => {
    const widget = createElement('div', {
      class: 'reference-preview-widget',
      'data-widget-annotation-id': 'ann-1',
    });
    const result = handleWidgetClick(widget);
    expect(result.motivation).toBe('linking');
  });
});

describe('dispatchWidgetClick', () => {
  it('does nothing when not handled', () => {
    const eventBus = makeEventBus();
    dispatchWidgetClick({ handled: false }, eventBus);
    expect(eventBus.get).not.toHaveBeenCalled();
  });

  it('emits browse:reference-navigate for navigate action', () => {
    const eventBus = makeEventBus();
    const result: WidgetClickResult = {
      handled: true,
      action: 'navigate',
      documentId: 'doc-1',
      annotationId: 'ann-1',
    };
    dispatchWidgetClick(result, eventBus);
    expect(eventBus.get).toHaveBeenCalledWith('browse:reference-navigate');
    expect(eventBus.subjects['browse:reference-navigate']!.next).toHaveBeenCalledWith({ documentId: 'doc-1' });
  });

  it('emits browse:click for browse-click action', () => {
    const eventBus = makeEventBus();
    const result: WidgetClickResult = {
      handled: true,
      action: 'browse-click',
      annotationId: 'ann-1',
      motivation: 'linking' as any,
    };
    dispatchWidgetClick(result, eventBus);
    expect(eventBus.get).toHaveBeenCalledWith('browse:click');
    expect(eventBus.subjects['browse:click']!.next).toHaveBeenCalledWith({
      annotationId: 'ann-1',
      motivation: 'linking',
    });
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
