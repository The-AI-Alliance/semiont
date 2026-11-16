import type { AnnotationId, EventBus, ResourceId } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import type { BeckonNamespace as IBeckonNamespace } from './types';

export class BeckonNamespace implements IBeckonNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  // ── Wire drives — beckon OTHER participants (the guided-tour moves) ────
  //
  // Each resolves with the subscriber count from `/bus/emit` (`-1` =
  // unknown; see `ITransport.emit`), so a driver can tell an empty room
  // from a full one. Arrivals come back bridged like any remote emit —
  // these methods never loop back onto the local bus.

  attention(resourceId: ResourceId, annotationId: AnnotationId): Promise<number> {
    return this.transport.emit('beckon:focus', { annotationId, resourceId });
  }

  /**
   * Open a resource on every OTHER participant's screen (wire:
   * `browse:resource-open` — the launcher's tour channel). The local
   * counterpart is `browse.openResource()`: this viewer's own panels.
   */
  openResource(resourceId: ResourceId): Promise<number> {
    return this.transport.emit('browse:resource-open', { resourceId });
  }

  /**
   * Open an annotation on every OTHER participant's screen (wire:
   * `browse:click` — the viewer selects its panel entry and scrolls to it).
   * Strictly richer than `attention()`, which only points.
   *
   * The local counterpart is `browse.click()`: this viewer's own. No audience
   * marker on the name — beckon has no local `click` sibling forcing the
   * distinction, the same reason `openResource` needs none and `sparkleAll`
   * does.
   */
  click(annotationId: AnnotationId): Promise<number> {
    return this.transport.emit('browse:click', { annotationId });
  }

  /**
   * Sparkle an annotation on every participant's viewer (wire:
   * `beckon:sparkle`). The `All` marker exists because `sparkle()` — the
   * unmarked sibling — is this viewer's own local affordance and must stay
   * local (GUIDED-TOUR D6: a wire emit here would broadcast one viewer's
   * own UI moment to the room).
   */
  sparkleAll(annotationId: AnnotationId): Promise<number> {
    return this.transport.emit('beckon:sparkle', { annotationId });
  }

  // ── Local signals — this viewer's own fan-out ──────────────────────────

  hover(annotationId: AnnotationId | null): void {
    // Local emit: beckon-state-unit subscribes via the local bus.
    this.bus.get('beckon:hover').next({ annotationId });
  }

  sparkle(annotationId: AnnotationId): void {
    this.bus.get('beckon:sparkle').next({ annotationId });
  }
}
