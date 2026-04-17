export { type ViewModel, createDisposer } from './lib/view-model';
export {
  createSearchPipeline,
  type SearchPipeline,
  type SearchPipelineOptions,
  type SearchState,
} from './lib/search-pipeline';
export {
  createBeckonVM,
  type BeckonVM,
  createHoverHandlers,
  type HoverHandlers,
  HOVER_DELAY_MS,
} from './flows/beckon-vm';
export {
  createBrowseVM,
  type BrowseVM,
  type BrowseVMOptions,
  type ToolbarPanelType,
  COMMON_PANELS,
  RESOURCE_PANELS,
} from './flows/browse-vm';
export {
  createGatherVM,
  type GatherVM,
} from './flows/gather-vm';
export {
  createMatchVM,
  type MatchVM,
} from './flows/match-vm';
export {
  createYieldVM,
  type YieldVM,
  type GenerateDocumentOptions,
} from './flows/yield-vm';
export {
  createMarkVM,
  type MarkVM,
  type PendingAnnotation,
} from './flows/mark-vm';
export {
  createBindVM,
  type BindVM,
} from './flows/bind-vm';

// Domain VMs — reusable across React, CLI, MCP
export {
  createDiscoverVM,
  type DiscoverVM,
} from './domain/discover-vm';
export {
  createEntityTagsVM,
  type EntityTagsVM,
} from './domain/entity-tags-vm';
export {
  createExchangeVM,
  type ExchangeVM,
  type ImportPreview,
} from './domain/exchange-vm';
export {
  createAdminUsersVM,
  type AdminUsersVM,
} from './domain/admin-users-vm';
export {
  createAdminSecurityVM,
  type AdminSecurityVM,
} from './domain/admin-security-vm';
export {
  createWelcomeVM,
  type WelcomeVM,
} from './domain/welcome-vm';
export {
  createResourceLoaderVM,
  type ResourceLoaderVM,
} from './domain/resource-loader-vm';
export {
  createSessionVM,
  type SessionVM,
} from './domain/session-vm';
export {
  createActorVM,
  type ActorVM,
  type ActorVMOptions,
  type BusEvent,
} from './domain/actor-vm';
export {
  createSmelterActorVM,
  type SmelterActorVM,
  type SmelterActorVMOptions,
  type SmelterEvent,
} from './domain/smelter-actor-vm';
export {
  createWorkerVM,
  type WorkerVM,
  type WorkerVMOptions,
  type JobAssignment,
  type ActiveJob,
} from './domain/worker-vm';
export {
  createJobQueueVM,
  type JobQueueVM,
  type Job,
} from './domain/job-queue-vm';

// Page composites — React UI layout orchestration
export {
  createResourceViewerPageVM,
  type ResourceViewerPageVM,
  type WizardState,
  type AnnotationGroups,
} from './pages/resource-viewer-page-vm';
export {
  createComposePageVM,
  type ComposePageVM,
  type ComposeParams,
  type ComposeMode,
  type CloneData,
  type ReferenceData,
  type SaveResourceParams,
} from './pages/compose-page-vm';
