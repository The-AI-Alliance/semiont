import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createSelectionRouter, type SelectionsRouterType } from './shared';
import { formatDocument, formatSelection } from './helpers';
import { getGraphDatabase } from '../../graph/factory';
import { getStorageService } from '../../storage/filesystem';

// Create router with auth middleware
export const documentRouter: SelectionsRouterType = createSelectionRouter();

// All document-related selection routes will be added here
// For now, keeping empty to avoid TypeScript complexity issues