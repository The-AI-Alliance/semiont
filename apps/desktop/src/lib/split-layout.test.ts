import { describe, expect, it } from 'vitest';
import { CHAT_MIN, DOC_MIN, clampDocWidth, mainLayout } from './split-layout';

describe('mainLayout (what the main pane shows: chat, doc, or both side by side)', () => {
  it('splits when a doc is open beside an active chat and there is room for both', () => {
    expect(mainLayout({ docOpen: true, chatActive: true, containerWidth: 1000 })).toBe('split');
  });

  it('falls back to the doc-takes-precedence swap when too narrow to split', () => {
    expect(mainLayout({ docOpen: true, chatActive: true, containerWidth: CHAT_MIN + DOC_MIN - 1 })).toBe('doc');
  });

  it('doc alone (no active chat) fills the pane', () => {
    expect(mainLayout({ docOpen: true, chatActive: false, containerWidth: 1400 })).toBe('doc');
  });

  it('chat alone fills the pane (also the no-doc empty/connect states)', () => {
    expect(mainLayout({ docOpen: false, chatActive: true, containerWidth: 1400 })).toBe('chat');
    expect(mainLayout({ docOpen: false, chatActive: false, containerWidth: 1400 })).toBe('chat');
  });

  it('an unmeasured container (first paint, width 0) never splits', () => {
    expect(mainLayout({ docOpen: true, chatActive: true, containerWidth: 0 })).toBe('doc');
  });
});

describe('clampDocWidth (the divider keeps both panes at least their minimum)', () => {
  it('clamps below to DOC_MIN', () => {
    expect(clampDocWidth(100, 1200)).toBe(DOC_MIN);
  });

  it('clamps above so the chat keeps CHAT_MIN even after the 1px divider', () => {
    expect(clampDocWidth(2000, 1200)).toBe(1200 - CHAT_MIN - 1);
  });

  it('passes an in-range width through', () => {
    expect(clampDocWidth(520, 1200)).toBe(520);
  });
});
