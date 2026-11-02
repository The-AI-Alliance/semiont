import { test, expect } from '@playwright/test';
import { signInSession } from '../fixtures/sdk-session';

/**
 * What refers to a resource is answered every time it is asked in the seconds
 * after an annotation is recorded on it.
 *
 * Those seconds are when the record has just changed under every reader of
 * it. Spec 05 passes through the same moment (it makes a reference, and the
 * page then asks what refers to the resource) and asserts nothing about the
 * answer. This spec asks again and again after each of several annotations.
 *
 * Each annotation is distinct, because an annotation's id is a hash of its
 * content: a repeat would record nothing and change nothing.
 *
 * Self-seeding: its own resource, so it does not depend on the global seed.
 */

const STAMP = `${Date.now().toString(36)}`;
const ANNOTATIONS = 3;
const ASK_EVERY_MS = 50;
const ASK_FOR_MS = 2_500;

test.describe('what refers to a resource, just after an annotation', () => {
  test('is answered every time it is asked in the seconds after each annotation is recorded', async () => {
    test.setTimeout(90_000);

    const opened = await signInSession();
    const client = opened.session.client;

    try {
      const { resourceId } = await client.yield.resource({
        name: `Referenced-by Doc ${STAMP}`,
        storageUri: `file://e2e/referenced-by-${STAMP}.txt`,
        file: Buffer.from('A resource whose view grows with each annotation recorded on it.', 'utf-8'),
        format: 'text/plain',
        language: 'en',
      });

      // Answered once before any annotation: the view exists, and the
      // Librarian has read it at its first length.
      await expect
        .poll(
          () => client.gather.referencedBy(resourceId).fresh().then(() => 'answered', (error: Error) => error.message),
          { timeout: 30_000 },
        )
        .toBe('answered');

      for (let n = 1; n <= ANNOTATIONS; n++) {
        await client.mark.annotation({
          target: { source: resourceId },
          motivation: 'commenting',
          body: [{ type: 'TextualBody', value: `Comment ${n} of ${ANNOTATIONS}, ${STAMP}.`, purpose: 'commenting' }],
        });
        const recordedAt = Date.now();

        while (Date.now() - recordedAt < ASK_FOR_MS) {
          await expect(
            client.gather.referencedBy(resourceId).fresh(),
            `what refers to the resource, asked ${Date.now() - recordedAt} ms after annotation ${n} was recorded`,
          ).resolves.toBeDefined();
          await new Promise((resolve) => setTimeout(resolve, ASK_EVERY_MS));
        }
      }
    } finally {
      opened.dispose();
    }
  });
});
