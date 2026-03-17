# Reference Resolution Wizard

A single multi-step wizard modal for resolving stub reference annotations. The user clicks one button on a stub reference, sees the gathered context, then chooses a resolution strategy.

## Entry Point

The three current stub reference buttons (✨ Generate, 🔍 Find, ✏️ Write) are replaced by a single button:

- **Emoji**: 🕸️🧙
- **Hover text**: "Gather Context to build Knowledge"
- **Event**: emits `bind:initiate` → triggers `gather:requested` and opens the wizard

## Step 1: Gather Context

The wizard opens immediately showing a loading state. When `gather:complete` fires, the `GatheredContext` is displayed:

- **Source context**: before/selected/after text with the selected span highlighted
- **Entity types**: badges for each type detected on the annotation
- **Graph context** (if present):
  - Connected resources (with bidirectional/mutual indicators)
  - Cited-by count and references
  - Sibling entity types

**Actions**: Cancel | Bind | Generate | Compose

The user sees context first, then decides the resolution strategy. Context informs the decision — strong graph connections suggest Bind; no matches suggest Generate or Compose.

**Component**: `GatherContextStep`

## Path A: Bind (Find Existing Resource)

### Step 2A: Configure Search

**Form fields**:

| Field | Type | Default |
|-------|------|---------|
| Max results | select (1, 5, 10, 20) | 10 |
| Semantic scoring | toggle | on (when InferenceClient available) |

No search term input — the full `GatheredContext` drives the search via the Matcher's `contextDrivenSearch`.

**Actions**: Cancel | Back | Search

**On submit**: Emits `bind:search-requested` with the `GatheredContext`, `limit`, and `useSemanticScoring` flag.

### Step 3A: Search Results

Shows scored results from `bind:search-results`. Each result displays name, score, match reason.

**Actions for each result**: Link (confirms binding)

**Footer actions**: Back (returns to Step 1 to choose a different strategy)

**On Link**: Emits `bind:update-body` to link the reference → 🔗 appears on the reference entry. Wizard closes.

**On Back**: Returns to Step 1 (context is preserved, no re-fetch). User can choose Generate or Compose instead.

## Path B: Generate (AI-Create Resource)

### Step 2B: Configure Generation

**Form fields**:

| Field | Type | Default |
|-------|------|---------|
| Resource title | text input | Selected text from reference |
| Additional instructions | textarea | empty |
| Language | select (from `LOCALES`) | Current locale |
| Creativity (temperature) | range slider 0–1 | 0.7 |
| Max length (tokens) | number input 100–4000 | 500 |

**Actions**: Cancel | Back | Generate

**On submit**: Emits `yield:request` with title, prompt, language, temperature, maxTokens, and the `GatheredContext`. Wizard closes. The SSE stream drives `yield:progress` → `yield:finished`, showing the pulsing/sparkling animation on the reference entry. When complete, 🔗 appears.

## Path C: Compose (Manual Write)

Clicking "Compose" closes the wizard and navigates to `/compose` with the `GatheredContext` passed along. The context is *not* re-fetched — it was already gathered in Step 1 and is passed to the compose page via sessionStorage (too large for URL params).

The compose page is modified to optionally display the received `GatheredContext` as a reference panel, so the user can see the source context, entity types, and graph connections while writing.

When the composed resource is saved, the compose page already handles linking the reference back (`updateAnnotationBody` in compose `page.tsx`).

## Implementation

### Architecture note

The wizard lives in `packages/react-ui/` and uses the framework-agnostic `TranslationContext` (via `useTranslations`). The frontend `page.tsx` no longer passes `GenerationConfigModal` as a prop — `ResourceViewerPage` renders `ReferenceWizardModal` directly.

### New files

| File | Purpose |
|------|---------|
| `packages/react-ui/src/components/modals/ReferenceWizardModal.tsx` | Wizard shell: step management, modal chrome |
| `packages/react-ui/src/components/modals/GatherContextStep.tsx` | Step 1: loading → context preview → Cancel/Bind/Generate/Compose |
| `packages/react-ui/src/components/modals/ConfigureGenerationStep.tsx` | Step 2B: generation config form |
| `packages/react-ui/src/components/modals/ConfigureSearchStep.tsx` | Step 2A: search config form |
| `packages/react-ui/src/components/modals/SearchResultsStep.tsx` | Step 3A: scored results list with Link/Back |

### Deleted files

Replaced by `ReferenceWizardModal` — delete completely, not deprecated:

| File | Reason |
|------|--------|
| `apps/frontend/src/components/modals/GenerationConfigModal.tsx` | Replaced by wizard Generate path |
| `packages/react-ui/src/components/modals/BindContextModal.tsx` | Replaced by wizard Bind path |
| `apps/frontend/src/components/modals/__tests__/GenerationConfigModal.test.tsx` | Tests rewritten for wizard |

### Call site updates

No re-exports, no aliases, no compatibility shims:

| File | Change |
|------|--------|
| `packages/react-ui/src/components/resource/panels/ReferenceEntry.tsx` | Replace three stub buttons (✨🔍✏️) with single 🕸️🧙 button. Emit `bind:initiate` instead of three separate events. |
| `packages/react-ui/src/features/resource-viewer/components/ResourceViewerPage.tsx` | Remove `BindContextModal` import and `GenerationConfigModal` prop. Render single `ReferenceWizardModal`. |
| `packages/react-ui/src/features/resource-viewer/components/ResourceViewerPage.tsx` (`ResourceViewerPageProps`) | Remove `GenerationConfigModal: React.ComponentType<any>` from props interface |
| `packages/react-ui/src/hooks/useYieldFlow.ts` | Remove `yield:modal-open` subscription (wizard handles this). Remove `bind:create-manual` handler (wizard handles compose navigation). Keep SSE/progress logic. |
| `packages/react-ui/src/hooks/useBindFlow.ts` | Remove `bind:link` subscription and context modal state (wizard handles this). Keep `bind:update-body` and search result handling. |
| `packages/react-ui/src/index.ts` | Remove `BindContextModal` export, add `ReferenceWizardModal` export |
| `packages/react-ui/src/types/modals.ts` | Remove `GenerationConfigModalProps`, add `ReferenceWizardModalProps` |
| `apps/frontend/src/app/[locale]/know/resource/[id]/page.tsx` | Remove `GenerationConfigModal` import and prop pass-through |
| `apps/frontend/src/app/[locale]/know/compose/page.tsx` | Read `GatheredContext` from sessionStorage; pass to `ResourceComposePage` for optional display |
| `packages/react-ui/src/features/resource-viewer/__tests__/ResourceViewerPage.test.tsx` | Update to remove `GenerationConfigModal` prop and mock |
| `packages/react-ui/src/features/resource-viewer/__tests__/YieldFlowIntegration.test.tsx` | Update: `yield:modal-open` → `bind:initiate`; remove `bind:create-manual` tests |
| `packages/react-ui/src/features/resource-viewer/__tests__/BindFlowIntegration.test.tsx` | Update: `bind:link` → `bind:initiate` |
| `packages/react-ui/src/hooks/__tests__/useBindFlow.test.tsx` | Update: `bind:link` → `bind:initiate`; update two-step flow tests |
| `packages/react-ui/src/components/resource/panels/__tests__/ReferenceEntry.test.tsx` | Update: three button tests → single `bind:initiate` button test; remove `yield:modal-open`, `bind:link`, `bind:create-manual` event assertions |
| `apps/frontend/messages-source/*.json` | Move `GenerationConfigModal` keys to `ReferenceWizard` namespace (all locale files) |

### Documentation updates

| File | Change |
|------|--------|
| `packages/react-ui/docs/EVENTS.md` | Update event catalog: remove `yield:modal-open`, `bind:link`, `bind:create-manual`; add `bind:initiate` |
| `packages/react-ui/docs/ANNOTATION-CLICK.md` | Update click flow docs for new single-button wizard |
| `docs/flows/BIND.md` | Update to reflect wizard flow replacing direct `bind:link` |
| `docs/flows/GATHER.md` | Update to reflect `bind:initiate` as trigger (replaces `yield:modal-open` and `bind:link`) |

### Event changes

| File | Change |
|------|--------|
| `packages/core/src/event-map.ts` | Add `bind:initiate` event. Add `limit?: number` and `useSemanticScoring?: boolean` to `bind:search-requested`. Remove `yield:modal-open` (replaced by `bind:initiate`). Remove `bind:link` (replaced by `bind:initiate`). Remove `bind:create-manual` (wizard handles compose navigation). |

### Backend changes

| File | Change |
|------|--------|
| `packages/make-meaning/src/matcher.ts` | Respect `limit` (slice scored results) and `useSemanticScoring` (skip `inferenceSemanticScore` when false) in `contextDrivenSearch` |

### Compose page changes

| File | Change |
|------|--------|
| `apps/frontend/src/app/[locale]/know/compose/page.tsx` | Read `GatheredContext` from sessionStorage keyed by annotationId; pass as prop |
| `packages/react-ui/src/features/compose/ResourceComposePage.tsx` (or equivalent) | Accept optional `gatheredContext` prop; render context panel when present |

### Type safety

Wizard step is a discriminated union — no `any` casts:

```typescript
type WizardStep =
  | { step: 'gather' }
  | { step: 'configure-search' }
  | { step: 'search-results'; results: ScoredResult[] }
  | { step: 'configure-generation' };
```

`ResourceViewerPageProps` loses its `GenerationConfigModal: React.ComponentType<any>` prop entirely.

### Deleted concepts

- Three separate stub reference buttons → one wizard button
- `searchTerm` in `bind:search-requested` → context-driven search replaces it
- `yield:modal-open` event → `bind:initiate` replaces it
- `bind:link` event → `bind:initiate` replaces it
- `bind:create-manual` event → wizard handles compose navigation directly

## Ranking Signals (Reference)

The Matcher's `contextDrivenSearch` scores candidates using these signals (not user-configurable):

| Signal | Max points | Source |
|--------|-----------|--------|
| Entity type overlap (Jaccard + IDF) | 30 | `GatheredContext.metadata.entityTypes` |
| Name match quality (exact/prefix/contains) | 25/15/10 | Selected text from annotation |
| Bidirectional connection | 20 | `GatheredContext.graphContext.connections` |
| Unidirectional connection | 10 | `GatheredContext.graphContext.connections` |
| Citation weight | 15 | `GatheredContext.graphContext.citedByCount` |
| Recency | 5 | `resource.dateCreated` |
| Multi-source bonus | 3/source | Found by multiple retrieval strategies |
| Semantic scoring (LLM) | 25 | `InferenceClient.generateText` (optional) |
