import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import type { SemiontApiClient } from '../../client';
import type { ViewModel } from '../lib/view-model';

export interface BeckonVM extends ViewModel {
  hoveredAnnotationId$: Observable<string | null>;
  hover(annotationId: string | null): void;
  focus(annotationId: string): void;
  sparkle(annotationId: string): void;
}

export function createBeckonVM(client: SemiontApiClient): BeckonVM {
  const subs: Subscription[] = [];
  const hovered$ = new BehaviorSubject<string | null>(null);

  subs.push(client.stream('beckon:hover').subscribe(({ annotationId }) => {
    hovered$.next(annotationId);
    if (annotationId) {
      client.emit('beckon:sparkle', { annotationId });
    }
  }));

  subs.push(client.stream('browse:click').subscribe(({ annotationId }) => {
    client.emit('beckon:focus', { annotationId });
  }));

  return {
    hoveredAnnotationId$: hovered$.asObservable(),
    hover: (annotationId) => client.emit('beckon:hover', { annotationId }),
    focus: (annotationId) => client.emit('beckon:focus', { annotationId }),
    sparkle: (annotationId) => client.emit('beckon:sparkle', { annotationId }),
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
