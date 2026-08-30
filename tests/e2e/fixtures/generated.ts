import { expect } from '@playwright/test';
import { SemiontClient } from '@semiont/sdk';
import { getPrimaryMediaType } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
import { GATEWAY_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';

/**
 * Read a generated resource's descriptor over a SEPARATE signed-in client.
 *
 * `job:complete` proves the worker finished; it does not prove what the worker
 * wrote. Asking the gateway afresh is what distinguishes "the generation ran"
 * from "the generation produced the resource the form asked for" — the
 * distinction GENERATION-OUTPUT-FORMAT's D6 turns on, since the worker used to
 * derive the filename from the title and silently discard `storageUri`.
 *
 * Polls because `job:complete` and read-model availability are not the same
 * instant.
 */
export async function generatedDescriptor(
  name: string,
  timeout = 60_000,
): Promise<ResourceDescriptor> {
  const client = await SemiontClient.signInHttp({
    baseUrl: GATEWAY_URL,
    email: E2E_EMAIL,
    password: E2E_PASSWORD,
  });
  try {
    let hit: ResourceDescriptor | undefined;
    await expect
      .poll(
        async () => {
          const { resources } = await client.browse.resources({ search: name }).fresh();
          hit = resources.find((r) => r.name === name);
          return hit !== undefined;
        },
        { timeout, message: `no generated resource named "${name}" reached the read model` },
      )
      .toBe(true);
    if (!hit) throw new Error(`unreachable: poll resolved without a descriptor for "${name}"`);
    return hit;
  } finally {
    client.dispose();
  }
}

/**
 * Assert a generated resource landed where the form said and in the format the
 * form chose. `storagePath` is what the user types — the field renders a
 * `file://` adornment and `ConfigureGenerationStep` prepends it on submit.
 */
export async function expectGeneratedAt(
  name: string,
  storagePath: string,
  mediaType: string,
): Promise<ResourceDescriptor> {
  const descriptor = await generatedDescriptor(name);
  expect(
    descriptor.storageUri,
    'the artifact landed at the path typed into Save location, not one derived from the title (D6)',
  ).toBe(`file://${storagePath}`);
  expect(
    getPrimaryMediaType(descriptor),
    'the descriptor names the format chosen in the Format dropdown',
  ).toBe(mediaType);
  return descriptor;
}
