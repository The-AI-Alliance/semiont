import { useCallback } from 'react';
import type { ResourceUri } from '@semiont/api-client';
import { useResources, useToast } from '@semiont/react-ui';
import type { SemiontResource } from '@semiont/react-ui';

export interface UseResourceMutationsResult {
  updateTags: (tags: string[]) => Promise<void>;
  archive: () => Promise<void>;
  unarchive: () => Promise<void>;
  generateCloneLink: () => Promise<void>;
}

export function useResourceMutations(
  rUri: ResourceUri,
  resource: SemiontResource | undefined,
  refetchDocument: () => Promise<unknown>
): UseResourceMutationsResult {
  const resources = useResources();
  const { showSuccess, showError } = useToast();

  const updateDocMutation = resources.update.useMutation();
  const generateCloneTokenMutation = resources.generateCloneToken.useMutation();

  const updateTags = useCallback(async (tags: string[]) => {
    try {
      await updateDocMutation.mutateAsync({
        rUri,
        data: { entityTypes: tags }
      });
      showSuccess('Document tags updated successfully');
      await refetchDocument();
    } catch (err) {
      console.error('Failed to update document tags:', err);
      showError('Failed to update document tags');
    }
  }, [rUri, updateDocMutation, refetchDocument, showSuccess, showError]);

  const archive = useCallback(async () => {
    if (!resource) return;

    try {
      await updateDocMutation.mutateAsync({
        rUri,
        data: { archived: true }
      });
      await refetchDocument();
      showSuccess('Document archived');
    } catch (err) {
      console.error('Failed to archive document:', err);
      showError('Failed to archive document');
    }
  }, [resource, rUri, updateDocMutation, refetchDocument, showSuccess, showError]);

  const unarchive = useCallback(async () => {
    if (!resource) return;

    try {
      await updateDocMutation.mutateAsync({
        rUri,
        data: { archived: false }
      });
      await refetchDocument();
      showSuccess('Document unarchived');
    } catch (err) {
      console.error('Failed to unarchive document:', err);
      showError('Failed to unarchive document');
    }
  }, [resource, rUri, updateDocMutation, refetchDocument, showSuccess, showError]);

  const generateCloneLink = useCallback(async () => {
    if (!resource) return;

    try {
      const result = await generateCloneTokenMutation.mutateAsync(rUri);
      const token = result.token;
      const cloneUrl = `${window.location.origin}/know/clone?token=${token}`;

      await navigator.clipboard.writeText(cloneUrl);
      showSuccess('Clone link copied to clipboard');
    } catch (err) {
      console.error('Failed to generate clone token:', err);
      showError('Failed to generate clone link');
    }
  }, [resource, rUri, generateCloneTokenMutation, showSuccess, showError]);

  return {
    updateTags,
    archive,
    unarchive,
    generateCloneLink,
  };
}
