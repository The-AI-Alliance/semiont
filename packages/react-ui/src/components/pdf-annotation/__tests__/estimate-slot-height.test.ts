/**
 * PDF-CONTINUOUS-SCROLL S1b.
 *
 * The scroll column reserves space for unmounted pages. If the reservation is
 * wrong, every mount and unmount changes the column's height and the scrollbar
 * jumps — which is what S1 shipped, by reserving the raster height rather than
 * the displayed one.
 *
 * These pins hold the estimate to the CSS the image is actually under:
 * `max-width: 100%; height: auto`.
 */
import { describe, it, expect } from 'vitest';
import { estimateSlotHeight } from '../estimate-slot-height';

// US Letter at scale 1.5: 918 × 1188 raster, aspect 792/612.
const ASPECT = 792 / 612;
const RASTER_W = 918;

describe('estimateSlotHeight', () => {
  it('scales to the column when the column is narrower than the raster', () => {
    // The common case: `max-width: 100%` shrinks the image to the column.
    expect(estimateSlotHeight(600, RASTER_W, ASPECT)).toBe(Math.round(600 * ASPECT));
  });

  it('never upscales past the raster — max-width shrinks only', () => {
    // A column wider than the raster leaves the image at natural size, so the
    // height stops growing. Reserving columnWidth * aspect here would over-
    // reserve and leave a gap under every page.
    expect(estimateSlotHeight(1600, RASTER_W, ASPECT)).toBe(Math.round(RASTER_W * ASPECT));
  });

  it('is exactly the raster height when the column matches the raster', () => {
    expect(estimateSlotHeight(RASTER_W, RASTER_W, ASPECT)).toBe(Math.round(RASTER_W * ASPECT));
  });

  it('does NOT use the raster height as a width-independent constant', () => {
    // The S1 defect, stated as a pin: the raster is 1188px tall, but in a
    // 600px column the page occupies ~776px. Reserving 1188 is what made the
    // column's height lurch on every mount.
    const rasterHeight = Math.round(RASTER_W * ASPECT); // 1188
    expect(estimateSlotHeight(600, RASTER_W, ASPECT)).not.toBe(rasterHeight);
    expect(estimateSlotHeight(600, RASTER_W, ASPECT)).toBeLessThan(rasterHeight);
  });

  it('answers null until every measurement is in, rather than guessing', () => {
    // A wrong reservation is worse than none: an unsized slot is stable, a
    // mis-sized one moves when the page lands.
    expect(estimateSlotHeight(null, RASTER_W, ASPECT)).toBeNull();
    expect(estimateSlotHeight(600, null, ASPECT)).toBeNull();
    expect(estimateSlotHeight(600, RASTER_W, null)).toBeNull();
    expect(estimateSlotHeight(0, RASTER_W, ASPECT)).toBeNull();
  });
});
