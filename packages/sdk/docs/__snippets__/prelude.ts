// Ambient vocabulary for the sdk docs' code fences (SAFE-DOCS design point 3).
//
// Prose snippets stay terse because the names they lean on are declared here
// once, typed against the real surface. This file is itself contract surface:
// if it stops type-checking, that's a catch, not noise. (It is a checked .ts
// module, NOT a .d.ts — skipLibCheck would silently swallow errors in a
// declaration file, which is how a bad import hid on the gate's first run.) Review rule: a snippet
// edit that adds boilerplate to satisfy the gate is wrong — extend this
// prelude instead.
import type {
  SemiontSession as _SemiontSession,
  SemiontClient as _SemiontClient,
  ResourceId as _ResourceId,
  AnnotationId as _AnnotationId,
  GatheredContext as _GatheredContext,
  SessionStorage as _SessionStorage,
  KnowledgeBase as _KnowledgeBase,
  ResourceDescriptor as _ResourceDescriptor,
  Annotation as _Annotation,
  GenerationOptions as _GenerationOptions,
  TagSchema as _TagSchema,
  CacheState as _CacheState,
  AccessToken as _AccessToken,
  Logger as _Logger,
  CreateAnnotationInput as _CreateAnnotationInput,
  StateUnit as _StateUnit,
  JobId as _JobId,
  UserDID as _UserDID,
} from '@semiont/sdk';
import type { FaultyTransport as _FaultyTransport } from '@semiont/sdk/testing';
import type { ShellStateUnit as _ShellStateUnit } from '@semiont/react-ui';

declare global {
  // ── type vocabulary snippets use in annotations ──────────────────────
  type SemiontSession = _SemiontSession;
  type SemiontClient = _SemiontClient;
  type StateUnit = _StateUnit;
  type CacheState<T> = _CacheState<T>;
  type AccessToken = _AccessToken;
  type ShellStateUnit = _ShellStateUnit;
  type Observable<T> = import('rxjs').Observable<T>;
  type Subscription = import('rxjs').Subscription;
  type BehaviorSubject<T> = import('rxjs').BehaviorSubject<T>;
  const BehaviorSubject: typeof import('rxjs').BehaviorSubject;

  // ── sample-local placeholder types (STATE-UNITS anatomy/composition) ─
  type Input = { resourceId: _ResourceId };
  type Result = unknown;
  type ComposeParams = Record<string, unknown>;
  type ComposePageStateUnit = _StateUnit;

  // ── the signed-in world most snippets assume ─────────────────────────
  /** A signed-in session (long-running consumers). */
  const session: _SemiontSession;
  /** A wired-up client — one-shot scripts call it `semiont`, sessions `client`. */
  const semiont: _SemiontClient;
  const client: _SemiontClient;
  /** The scriptable test transport from `@semiont/sdk/testing` snippets. */
  const transport: _FaultyTransport;
  const token$: import('rxjs').BehaviorSubject<_AccessToken | null>;

  // ── ids and domain values ────────────────────────────────────────────
  const resourceId: _ResourceId;
  const rId: _ResourceId;
  const sourceDocId: _ResourceId;
  const targetDocId: _ResourceId;
  const targetResourceId: _ResourceId;
  const annotationId: _AnnotationId;
  const aId: _AnnotationId;
  const referenceId: _AnnotationId;
  const refId: _AnnotationId;
  const claimId: _AnnotationId;
  const jobId: _JobId;
  const userId: _UserDID;
  const resource: _ResourceDescriptor;
  const annotation: _Annotation;
  const context: _GatheredContext;
  const ctx: _GatheredContext;
  const gatheredContext: _GatheredContext;
  const resourceContext: _GatheredContext;
  const options: _GenerationOptions;
  const input: _CreateAnnotationInput;
  const MY_TAG_SCHEMA: _TagSchema;
  const kb: _KnowledgeBase;
  const storage: _SessionStorage;
  const logger: _Logger;
  const sub: Subscription;
  const ourSubs: Subscription[];
  const error: Error;
  const file: File;
  const entityTypes: string[];
  const orchestrator: { run(): Promise<void> };
  const pageOne: Record<string, unknown>;
  const pageTwo: Record<string, unknown>;

  // ── plain scalars snippets pass around ───────────────────────────────
  const question: string;
  const text: string;
  const email: string;
  const password: string;
  const baseUrl: string;
  const kbId: string;
  const kbsJsonPath: string;
  const credential: string;
  const newToken: string;
  const refreshToken: string;
  const content: string;
  const start: number;
  const end: number;

  // ── the app around the snippet (UI callbacks, logging, IO, tests) ────
  /** Stand-ins for "your app's UI reacts here" — shape deliberately loose. */
  const render: (...args: unknown[]) => void;
  const highlight: (...args: unknown[]) => void;
  const log: (...args: unknown[]) => void;
  const setPct: (...args: unknown[]) => void;
  const updateProgress: (...args: unknown[]) => void;
  const showProgress: (...args: unknown[]) => void;
  const showSkeleton: (...args: unknown[]) => void;
  const showError: (...args: unknown[]) => void;
  const showLoadFailure: (...args: unknown[]) => void;
  const showManualEntryOnly: (...args: unknown[]) => void;
  const renderManagedKbs: (...args: unknown[]) => void;
  const retry: (...args: unknown[]) => void;
  const reauthenticate: (...args: unknown[]) => void;
  const celebrate: (...args: unknown[]) => void;
  /** Bring-your-own IO for the textDiscovery snippet (node's fs.readFile shape). */
  const readFile: (path: string, encoding: 'utf8') => Promise<string>;
  /** Test-framework stand-in for DEVELOPER-GUIDE testing snippets. */
  function expect(value: unknown): {
    toHaveLength(n: number): void;
    toMatchObject(shape: Record<string, unknown>): void;
    toBe(v: unknown): void;
  };
}

export {};
