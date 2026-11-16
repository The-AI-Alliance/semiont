import { describe, it, expect } from 'vitest';
import { renderAgentLabel } from '../agent-label';
import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];

describe('renderAgentLabel', () => {
  describe('Software peers', () => {
    it('composes `${provider} ${model}` from structured fields', () => {
      const agent: Agent = {
        '@type': 'Software',
        '@id': 'did:web:example.com:agents:ollama:gemma2%3A27b',
        name: 'unused-display-name',
        provider: 'ollama',
        model: 'gemma2:27b',
      };
      expect(renderAgentLabel(agent)).toBe('ollama gemma2:27b');
    });

    it('falls back to model alone when provider is absent', () => {
      const agent: Agent = {
        '@type': 'Software',
        name: 'unused',
        model: 'gpt-4',
      };
      expect(renderAgentLabel(agent)).toBe('gpt-4');
    });

    it('falls back to provider alone when model is absent', () => {
      const agent: Agent = {
        '@type': 'Software',
        name: 'unused',
        provider: 'anthropic',
      };
      expect(renderAgentLabel(agent)).toBe('anthropic');
    });

    it('falls back to name when both provider and model are absent', () => {
      const agent: Agent = {
        '@type': 'Software',
        name: 'Some Software',
      };
      expect(renderAgentLabel(agent)).toBe('Some Software');
    });
  });

  describe('Person and Organization peers', () => {
    it('renders Person name', () => {
      const agent: Agent = {
        '@type': 'Person',
        '@id': 'did:web:example.com:users:alice%40example.com',
        name: 'Alice',
      };
      expect(renderAgentLabel(agent)).toBe('Alice');
    });

    it('renders Organization name', () => {
      const agent: Agent = {
        '@type': 'Organization',
        name: 'Acme Corp',
      };
      expect(renderAgentLabel(agent)).toBe('Acme Corp');
    });
  });

  describe('Legacy and degraded shapes', () => {
    it('renders the stored `name` for legacy SoftwareAgent shape (graceful fallback)', () => {
      // Pre-migration generator with @type='SoftwareAgent' and concatenated name
      const legacy = {
        '@type': 'SoftwareAgent',
        name: 'worker-pool / ollama gemma4:26b',
        worker: 'worker-pool',
        inferenceProvider: 'ollama',
        model: 'gemma4:26b',
      } as unknown as Agent;
      expect(renderAgentLabel(legacy)).toBe('worker-pool / ollama gemma4:26b');
    });

    it('falls back to @id when name is empty', () => {
      const agent = {
        '@type': 'Person',
        '@id': 'did:web:example.com:users:bob%40example.com',
        name: '',
      } as unknown as Agent;
      expect(renderAgentLabel(agent)).toBe('did:web:example.com:users:bob%40example.com');
    });

    it('falls back to "unknown" when nothing identifies the agent', () => {
      const agent = { '@type': 'Person', name: '' } as unknown as Agent;
      expect(renderAgentLabel(agent)).toBe('unknown');
    });
  });
});
