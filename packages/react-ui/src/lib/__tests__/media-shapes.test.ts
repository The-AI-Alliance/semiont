import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSupportedShapes,
  isShapeSupported,
  getSelectorType,
  getSelectedShapeForSelectorType,
  saveSelectedShapeForSelectorType,
} from '../media-shapes';

describe('media-shapes', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getSupportedShapes', () => {
    it('returns no shapes for null/undefined mediaType — an unknown medium must not advertise drawing', () => {
      // Mirrors getSelectorType's 'text' fallback for absent media types.
      expect(getSupportedShapes(null)).toEqual([]);
      expect(getSupportedShapes(undefined)).toEqual([]);
    });

    it('returns only rectangle for PDF', () => {
      expect(getSupportedShapes('application/pdf')).toEqual(['rectangle']);
    });

    it('returns all shapes for images', () => {
      expect(getSupportedShapes('image/png')).toEqual(['rectangle', 'circle', 'polygon']);
      expect(getSupportedShapes('image/jpeg')).toEqual(['rectangle', 'circle', 'polygon']);
    });

    it('returns no shapes for text media — text anchors by character offsets', () => {
      // The set is the host-facing contract ("which shapes can this medium
      // draw"); text media have no selector that can carry a shape.
      expect(getSupportedShapes('text/plain')).toEqual([]);
      expect(getSupportedShapes('text/markdown')).toEqual([]);
      expect(getSupportedShapes('text/html')).toEqual([]);
    });
  });

  describe('isShapeSupported', () => {
    it('returns true for supported shapes', () => {
      expect(isShapeSupported('image/png', 'circle')).toBe(true);
      expect(isShapeSupported('application/pdf', 'rectangle')).toBe(true);
    });

    it('returns false for unsupported shapes', () => {
      expect(isShapeSupported('application/pdf', 'circle')).toBe(false);
      expect(isShapeSupported('application/pdf', 'polygon')).toBe(false);
    });

    it('is false for every shape on text media', () => {
      expect(isShapeSupported('text/plain', 'rectangle')).toBe(false);
      expect(isShapeSupported('text/plain', 'circle')).toBe(false);
      expect(isShapeSupported('text/markdown', 'polygon')).toBe(false);
    });
  });

  describe('getSelectorType', () => {
    it('returns text for null/undefined', () => {
      expect(getSelectorType(null)).toBe('text');
      expect(getSelectorType(undefined)).toBe('text');
    });

    it('returns fragment for PDF', () => {
      expect(getSelectorType('application/pdf')).toBe('fragment');
    });

    it('returns svg for images', () => {
      expect(getSelectorType('image/png')).toBe('svg');
      expect(getSelectorType('image/svg+xml')).toBe('svg');
    });

    it('returns text for text types', () => {
      expect(getSelectorType('text/plain')).toBe('text');
      expect(getSelectorType('text/html')).toBe('text');
    });
  });

  describe('getSelectedShapeForSelectorType', () => {
    it('returns rectangle for fragment selector', () => {
      expect(getSelectedShapeForSelectorType('fragment')).toBe('rectangle');
    });

    it('returns rectangle for text selector', () => {
      expect(getSelectedShapeForSelectorType('text')).toBe('rectangle');
    });

    it('returns rectangle as default for svg selector', () => {
      expect(getSelectedShapeForSelectorType('svg')).toBe('rectangle');
    });

    it('returns stored shape from localStorage for svg', () => {
      localStorage.setItem('semiont-toolbar-shape-svg', 'circle');
      expect(getSelectedShapeForSelectorType('svg')).toBe('circle');
    });

    it('ignores invalid stored values', () => {
      localStorage.setItem('semiont-toolbar-shape-svg', 'triangle');
      expect(getSelectedShapeForSelectorType('svg')).toBe('rectangle');
    });
  });

  describe('saveSelectedShapeForSelectorType', () => {
    it('saves shape to localStorage for svg selector', () => {
      saveSelectedShapeForSelectorType('svg', 'polygon');
      expect(localStorage.getItem('semiont-toolbar-shape-svg')).toBe('polygon');
    });

    it('does not save for fragment selector', () => {
      saveSelectedShapeForSelectorType('fragment', 'circle');
      expect(localStorage.getItem('semiont-toolbar-shape-svg')).toBeNull();
    });

    it('does not save for text selector', () => {
      saveSelectedShapeForSelectorType('text', 'circle');
      expect(localStorage.getItem('semiont-toolbar-shape-svg')).toBeNull();
    });
  });
});
