import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scrollAnnotationIntoView } from '../scroll-utils';

describe('scroll-utils', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    document.body.removeChild(root);
  });

  it('returns false for null annotationId', () => {
    expect(scrollAnnotationIntoView(null, root)).toBe(false);
  });

  it('returns false when annotation element not found', () => {
    expect(scrollAnnotationIntoView('nonexistent', root)).toBe(false);
  });

  it('returns true when annotation element is found', () => {
    const el = document.createElement('div');
    el.setAttribute('data-annotation-id', 'ann-1');
    root.appendChild(el);

    expect(scrollAnnotationIntoView('ann-1', root)).toBe(true);
  });

  it('adds pulse class and removes it after timeout', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    el.setAttribute('data-annotation-id', 'ann-2');
    root.appendChild(el);

    scrollAnnotationIntoView('ann-2', root, { pulse: true });
    expect(el.classList.contains('annotation-pulse')).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(el.classList.contains('annotation-pulse')).toBe(false);

    vi.useRealTimers();
  });

  it('does not add pulse class when pulse is false', () => {
    const el = document.createElement('div');
    el.setAttribute('data-annotation-id', 'ann-3');
    root.appendChild(el);

    scrollAnnotationIntoView('ann-3', root, { pulse: false });
    expect(el.classList.contains('annotation-pulse')).toBe(false);
  });

  it('scrolls container when element is not visible', () => {
    // Create a scroll container with the expected class
    const container = document.createElement('div');
    container.className = 'semiont-browse-view__content';
    Object.defineProperty(container, 'clientHeight', { value: 500 });
    container.scrollTo = vi.fn();

    const el = document.createElement('div');
    el.setAttribute('data-annotation-id', 'ann-4');
    Object.defineProperty(el, 'offsetTop', { value: 1000 });
    Object.defineProperty(el, 'offsetHeight', { value: 40 });

    // Mock getBoundingClientRect to indicate element is not visible
    el.getBoundingClientRect = vi.fn(() => ({
      top: -100, bottom: -60, left: 0, right: 100, width: 100, height: 40, x: 0, y: -100, toJSON: () => {},
    }));
    container.getBoundingClientRect = vi.fn(() => ({
      top: 0, bottom: 500, left: 0, right: 800, width: 800, height: 500, x: 0, y: 0, toJSON: () => {},
    }));

    container.appendChild(el);
    root.appendChild(container);

    scrollAnnotationIntoView('ann-4', root, { behavior: 'auto' });
    expect(container.scrollTo).toHaveBeenCalledWith({
      top: expect.any(Number),
      behavior: 'auto',
    });
  });

  it('does not scroll when element is already visible', () => {
    const container = document.createElement('div');
    container.className = 'semiont-browse-view__content';
    container.scrollTo = vi.fn();

    const el = document.createElement('div');
    el.setAttribute('data-annotation-id', 'ann-5');

    // Mock getBoundingClientRect to indicate element IS visible
    el.getBoundingClientRect = vi.fn(() => ({
      top: 100, bottom: 140, left: 0, right: 100, width: 100, height: 40, x: 0, y: 100, toJSON: () => {},
    }));
    container.getBoundingClientRect = vi.fn(() => ({
      top: 0, bottom: 500, left: 0, right: 800, width: 800, height: 500, x: 0, y: 0, toJSON: () => {},
    }));

    container.appendChild(el);
    root.appendChild(container);

    scrollAnnotationIntoView('ann-5', root);
    expect(container.scrollTo).not.toHaveBeenCalled();
  });

  it('escapes special characters in annotation ID', () => {
    const el = document.createElement('div');
    el.setAttribute('data-annotation-id', 'http://example.com/ann/1');
    root.appendChild(el);

    expect(scrollAnnotationIntoView('http://example.com/ann/1', root)).toBe(true);
  });
});
