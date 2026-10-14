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

/**
 * A pointer's dwell: an annotation is hovered once the pointer has rested on
 * it for `delayMs`, and no longer the moment it leaves. A pointer crossing
 * the page hovers nothing on its way. `emit` is told each change: the
 * annotation hovered, or none; `client.beckon.hover` is what it is usually
 * given. Disposing it forgets a rest that has not run its time, and it says
 * nothing more.
 */
export interface HoverDwell extends StateUnit {
  /** The pointer is on an annotation. One already hovered is not said again. */
  enter(annotationId: AnnotationId): void;
  /** The pointer left. Said at once, and only when something was hovered. */
  leave(): void;
}

export function createHoverDwell(emit: EmitHover, delayMs: number): HoverDwell {
  let currentHover: AnnotationId | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    enter(annotationId) {
      if (disposed || currentHover === annotationId) return;
      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        currentHover = annotationId;
        emit(annotationId);
      }, delayMs);
    },
    leave() {
      if (disposed) return;
      cancelTimer();
      if (currentHover !== null) {
        currentHover = null;
        emit(null);
      }
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}
