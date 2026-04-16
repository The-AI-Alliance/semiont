import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import type { EventBus } from '@semiont/core';
import type { ViewModel } from '../lib/view-model';

export interface BeckonVM extends ViewModel {
  hoveredAnnotationId$: Observable<string | null>;
  hover(annotationId: string | null): void;
  focus(annotationId: string): void;
  sparkle(annotationId: string): void;
}

export function createBeckonVM(eventBus: EventBus): BeckonVM {
  const subs: Subscription[] = [];
  const hovered$ = new BehaviorSubject<string | null>(null);

  subs.push(eventBus.get('beckon:hover').subscribe(({ annotationId }) => {
    hovered$.next(annotationId);
    if (annotationId) {
      eventBus.get('beckon:sparkle').next({ annotationId });
    }
  }));

  subs.push(eventBus.get('browse:click').subscribe(({ annotationId }) => {
    eventBus.get('beckon:focus').next({ annotationId });
  }));

  return {
    hoveredAnnotationId$: hovered$.asObservable(),
    hover: (annotationId) => eventBus.get('beckon:hover').next({ annotationId }),
    focus: (annotationId) => eventBus.get('beckon:focus').next({ annotationId }),
    sparkle: (annotationId) => eventBus.get('beckon:sparkle').next({ annotationId }),
    dispose() {
      subs.forEach(s => s.unsubscribe());
      hovered$.complete();
    },
  };
}

/** Default milliseconds the mouse must dwell before beckon:hover is emitted. */
export const HOVER_DELAY_MS = 150;

type EmitHover = (annotationId: string | null) => void;

export interface HoverHandlers {
  handleMouseEnter: (annotationId: string) => void;
  handleMouseLeave: () => void;
  cleanup: () => void;
}

export function createHoverHandlers(emit: EmitHover, delayMs: number): HoverHandlers {
  let currentHover: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const handleMouseEnter = (annotationId: string) => {
    if (currentHover === annotationId) return;
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      currentHover = annotationId;
      emit(annotationId);
    }, delayMs);
  };

  const handleMouseLeave = () => {
    cancelTimer();
    if (currentHover !== null) {
      currentHover = null;
      emit(null);
    }
  };

  return { handleMouseEnter, handleMouseLeave, cleanup: cancelTimer };
}
