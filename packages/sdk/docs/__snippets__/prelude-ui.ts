// Ambient vocabulary for the react-ui and Browser docs' code fences — the ui
// suite's counterpart of prelude.ts, under the same review rule: a snippet edit
// that adds boilerplate to satisfy the gate is wrong; extend this prelude.
//
// Package exports need no entry here: check.mjs imports them for a snippet
// from the ui suite's ambient modules. This file names only the host app's
// values a snippet leans on without declaring, typed against the real surface.
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import type {
  SemiontSession as _SemiontSession,
  SemiontClient as _SemiontClient,
  ResourceId as _ResourceId,
  AnnotationId as _AnnotationId,
  ResourceDescriptor as _ResourceDescriptor,
  Annotation as _Annotation,
  OpenResource as _OpenResource,
} from '@semiont/sdk';
import type {
  AnnotationHistory as _AnnotationHistory,
  LinkComponentProps as _LinkComponentProps,
  RouteBuilder as _RouteBuilder,
} from '@semiont/react-ui';

type Translate = (key: string, params?: Record<string, unknown>) => string;

declare global {
  // ── the signed-in world ──────────────────────────────────────────────
  const session: _SemiontSession;
  /** A wired-up client — `semiont` in one-shot code, `client` on a session. */
  const semiont: _SemiontClient;
  const client: _SemiontClient;

  // ── ids and domain values ────────────────────────────────────────────
  const resourceId: _ResourceId;
  const rId: _ResourceId;
  const annotationId: _AnnotationId;
  const aId: _AnnotationId;
  const hoveredAnnotationId: _AnnotationId | null;
  const resource: _ResourceDescriptor;
  const annotation: _Annotation;
  const annotations: _Annotation[];
  /** A resource's stored events, as `AnnotationHistory` takes them. */
  const events: ComponentProps<typeof _AnnotationHistory>['events'];
  const openResources: _OpenResource[];
  const content: string;
  const locale: string;
  const isAuthenticated: boolean;

  // ── the host's own navigation state ──────────────────────────────────
  const pathname: string;
  const navigate: (path: string) => void;
  const isCollapsed: boolean;

  // ── what a host passes to react-ui ───────────────────────────────────
  const Link: ComponentType<_LinkComponentProps>;
  const routes: _RouteBuilder;
  const t: Translate;
  const tNav: Translate;
  const tHome: Translate;
  const children: ReactNode;
}

export {};
