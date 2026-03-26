import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import type { User } from '@prisma/client';
import type { EventBus } from '@semiont/core';
import { registerBeckon } from './routes/beckon';
import { registerAttentionStream } from './routes/attention-stream';

type ParticipantsRouterType = Hono<{ Variables: { user: User; eventBus: EventBus } }>;

const participantsRouter: ParticipantsRouterType = new Hono<{ Variables: { user: User; eventBus: EventBus } }>();
participantsRouter.use('/api/participants/*', authMiddleware);

registerBeckon(participantsRouter);
registerAttentionStream(participantsRouter);

export { participantsRouter };
