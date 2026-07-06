'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SelectionMotivation, ClickAction, ShapeType } from '../components/annotation/AnnotateToolbar';
import { getSelectedShapeForSelectorType, saveSelectedShapeForSelectorType, type SelectorType } from '../lib/media-shapes';

const MODE_KEY = 'annotateMode';
const CLICK_KEY = 'semiont-toolbar-click';
const SELECTION_KEY = 'semiont-toolbar-selection';

export interface ToolbarPrefs {
  annotateMode: boolean;
  setAnnotateMode: (mode: boolean) => void;
  clickAction: ClickAction;
  setClickAction: (action: ClickAction) => void;
  selectionMotivation: SelectionMotivation | null;
  setSelectionMotivation: (motivation: SelectionMotivation | null) => void;
  shape: ShapeType;
  setShape: (shape: ShapeType) => void;
}

/**
 * The POLICY layer for toolbar preferences (TOOLBAR-PREFS-AS-PROPS): one shared,
 * localStorage-persisted prefs state — the Semiont Browser's global-toolbar UX,
 * relocated from inside the components to a visible page-layer hook. Feed the
 * returned values/setters to every viewer you compose (as its controlled props)
 * and they stay in lockstep and survive remounts. The components themselves hold
 * no persistence and no cross-instance sync; this hook is the one legitimate home
 * for both. Keys are the historical ones, so existing users' prefs carry over.
 *
 * `selectorType` scopes the SHAPE pref exactly as before: per selector type
 * (persisted only for 'svg'; 'fragment' is always rectangle).
 */
export function useToolbarPrefs(selectorType: SelectorType = 'text'): ToolbarPrefs {
  const [annotateMode, setAnnotateModeState] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(MODE_KEY) === 'true';
    }
    return false;
  });
  const setAnnotateMode = useCallback((mode: boolean) => {
    setAnnotateModeState(mode);
    if (typeof window !== 'undefined') localStorage.setItem(MODE_KEY, mode.toString());
  }, []);

  const [clickAction, setClickActionState] = useState<ClickAction>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(CLICK_KEY);
      if (stored && ['detail', 'follow', 'jsonld', 'deleting'].includes(stored)) {
        return stored as ClickAction;
      }
    }
    return 'detail';
  });
  const setClickAction = useCallback((action: ClickAction) => {
    setClickActionState(action);
    if (typeof window !== 'undefined') localStorage.setItem(CLICK_KEY, action);
  }, []);

  const [selectionMotivation, setSelectionMotivationState] = useState<SelectionMotivation | null>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(SELECTION_KEY);
      if (stored === 'null') return null;
      if (stored && ['linking', 'highlighting', 'assessing', 'commenting', 'tagging'].includes(stored)) {
        return stored as SelectionMotivation;
      }
    }
    return 'linking';
  });
  const setSelectionMotivation = useCallback((motivation: SelectionMotivation | null) => {
    setSelectionMotivationState(motivation);
    if (typeof window !== 'undefined') localStorage.setItem(SELECTION_KEY, motivation === null ? 'null' : motivation);
  }, []);

  const [shape, setShapeState] = useState<ShapeType>(() => getSelectedShapeForSelectorType(selectorType));
  // Re-derive the shape when the selector type changes (e.g. PDF ↔ image).
  useEffect(() => {
    setShapeState(getSelectedShapeForSelectorType(selectorType));
  }, [selectorType]);
  const setShape = useCallback((s: ShapeType) => {
    setShapeState(s);
    saveSelectedShapeForSelectorType(selectorType, s);
  }, [selectorType]);

  return { annotateMode, setAnnotateMode, clickAction, setClickAction, selectionMotivation, setSelectionMotivation, shape, setShape };
}
