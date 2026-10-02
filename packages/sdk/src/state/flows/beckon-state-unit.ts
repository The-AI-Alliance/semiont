import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import type { AnnotationId } from '@semiont/core';
import type { SemiontClient } from '../../client';
import type { StateUnit } from '@semiont/core';

export interface BeckonStateUnit extends StateUnit {
  hoveredAnnotationId$: Observable<AnnotationId | null>;
  focus(annotationId: AnnotationId): void;
}

export function createBeckonStateUnit(client: SemiontClient): BeckonStateUnit {
  const subs: Subscription[] = [];
  const hovered$ = new BehaviorSubject<AnnotationId | null>(null);

  subs.push(client.bus.on('beckon:hover').subscribe(({ annotationId }) => {
    hovered$.next(annotationId as AnnotationId | null);
    if (annotationId) {
      client.bus.emit('beckon:sparkle', { annotationId });
    }
  }));

  subs.push(client.bus.on('browse:click').subscribe(({ annotationId }) => {
    client.bus.emit('beckon:focus', { annotationId });
  }));

  return {
    hoveredAnnotationId$: hovered$.asObservable(),
    focus: (annotationId) => client.bus.emit('beckon:focus', { annotationId }),
    dispose() {
      subs.forEach(s => s.unsubscribe());
      hovered$.complete();
    },
  };
}

type EmitHover = (annotationId: AnnotationId | null) => void;

export interface HoverHandlers {
  handleMouseEnter: (annotationId: AnnotationId) => void;
  handleMouseLeave: () => void;
  cleanup: () => void;
}

export function createHoverHandlers(emit: EmitHover, delayMs: number): HoverHandlers {
  let currentHover: AnnotationId | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const handleMouseEnter = (annotationId: AnnotationId) => {
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
