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

    // MEDIA-CAPABILITY-DISPATCH D5: the dispatch asks the registry, never a
    // string prefix. These six image rows are storage tier — `anchoring:
    // 'none'`, `render: 'none'` — so they draw nothing, however their type
    // name begins.
    it('returns no shapes for storage-tier image types — the registry, not the prefix, decides', () => {
      for (const t of ['image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/tiff', 'image/x-icon']) {
        expect(getSupportedShapes(t)).toEqual([]);
      }
    });

    it('returns no shapes on a registry miss — import leniency means stored types need not be members (D2)', () => {
      expect(getSupportedShapes('image/x-obscure-raster')).toEqual([]);
      expect(getSupportedShapes('application/x-nonesuch')).toEqual([]);
    });

    it('reads through media-type parameters', () => {
      // capabilitiesOf keys off the base type, so the dispatch inherits that.
      expect(getSupportedShapes('image/png; charset=binary')).toEqual(['rectangle', 'circle', 'polygon']);
      expect(getSupportedShapes('image/gif; charset=binary')).toEqual([]);
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

    it('returns svg for spatially-anchored, image-rendered types', () => {
      expect(getSelectorType('image/png')).toBe('svg');
      expect(getSelectorType('image/jpeg')).toBe('svg');
    });

    it('returns text for text types', () => {
      expect(getSelectorType('text/plain')).toBe('text');
      expect(getSelectorType('text/html')).toBe('text');
    });

    // The `image/svg+xml` case previously asserted 'svg' — that pin encoded
    // the `startsWith('image/')` drift rather than the registry, which gives
    // every storage-tier image `anchoring: 'none'`. There is no 'none' member
    // of SelectorType, so they land on the catch-all; harmless, because
    // getSupportedShapes answers [] for them and the write path refuses (P3).
    it('does not claim svg for storage-tier image types (D5)', () => {
      for (const t of ['image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/tiff', 'image/x-icon']) {
        expect(getSelectorType(t)).not.toBe('svg');
        expect(getSelectorType(t)).toBe('text');
      }
    });

    it('does not claim svg or fragment on a registry miss (D2)', () => {
      expect(getSelectorType('image/x-obscure-raster')).toBe('text');
      expect(getSelectorType('application/x-nonesuch')).toBe('text');
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
