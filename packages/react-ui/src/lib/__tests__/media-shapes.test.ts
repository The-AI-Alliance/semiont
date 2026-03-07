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
    it('returns all shapes for null/undefined mediaType', () => {
      expect(getSupportedShapes(null)).toEqual(['rectangle', 'circle', 'polygon']);
      expect(getSupportedShapes(undefined)).toEqual(['rectangle', 'circle', 'polygon']);
    });

    it('returns only rectangle for PDF', () => {
      expect(getSupportedShapes('application/pdf')).toEqual(['rectangle']);
    });

    it('returns all shapes for images', () => {
      expect(getSupportedShapes('image/png')).toEqual(['rectangle', 'circle', 'polygon']);
      expect(getSupportedShapes('image/jpeg')).toEqual(['rectangle', 'circle', 'polygon']);
    });

    it('returns all shapes for unknown types', () => {
      expect(getSupportedShapes('text/plain')).toEqual(['rectangle', 'circle', 'polygon']);
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
