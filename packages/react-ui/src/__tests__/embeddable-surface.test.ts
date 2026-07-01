/**
 * EMBEDDABLE-RESOURCE-VIEWER step 5 — packaging gate.
 *
 * The bring-your-own-session consumer surface must be importable straight from
 * the barrel, so `import { ResourceViewer, useResourceLoader, useMediaToken,
 * useSessionEventSubscriptions } from '@semiont/react-ui'` works in a plain
 * Vite/Electron host with no app framework. (The "no `next/*` on the viewer path"
 * half of the gate is a static grep in the plan's step-5 log.)
 */
import { describe, it, expect } from 'vitest';
import * as reactUi from '../index';

describe('@semiont/react-ui — embeddable consumer surface', () => {
  it('exports the bring-your-own-session viewer pieces from the barrel', () => {
    expect(typeof reactUi.ResourceViewer).toBe('function');
    expect(typeof reactUi.useResourceLoader).toBe('function');
    expect(typeof reactUi.useMediaToken).toBe('function');
    expect(typeof reactUi.useSessionEventSubscriptions).toBe('function');
    expect(typeof reactUi.setPdfWorkerSrc).toBe('function');
    expect(typeof reactUi.defaultBrowseRenderers).toBe('object');
  });
});
