import { describe, it, expect } from 'vitest';
import { creatorName, renderAgentLabel, renderAgentLabels } from '../agent-label';
import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];

describe('renderAgentLabel', () => {
  describe('Software peers', () => {
    it('is labeled by its name, then the provider and model it runs', () => {
      const agent: Agent = {
        '@type': 'Software',
        '@id': 'did:web:example.com:agents:semiont-worker',
        name: 'my-highlighter',
        provider: 'ollama',
        model: 'gemma2:27b',
      };
      expect(renderAgentLabel(agent)).toBe('my-highlighter (ollama gemma2:27b)');
    });

    it('is labeled by its name and its model when it states no provider', () => {
      const agent: Agent = {
        '@type': 'Software',
        name: 'my-highlighter',
        model: 'gpt-4',
      };
      expect(renderAgentLabel(agent)).toBe('my-highlighter (gpt-4)');
    });

    it('is labeled by its name and its provider when it states no model', () => {
      const agent: Agent = {
        '@type': 'Software',
        name: 'my-highlighter',
        provider: 'anthropic',
      };
      expect(renderAgentLabel(agent)).toBe('my-highlighter (anthropic)');
    });

    it('is labeled by its provider and model when it has no profile', () => {
      const agent: Agent = {
        '@type': 'Software',
        '@id': 'did:web:example.com:agents:semiont-worker',
        provider: 'ollama',
        model: 'gemma2:27b',
      };
      expect(renderAgentLabel(agent)).toBe('ollama gemma2:27b');
    });

    it('is labeled by its model alone when it has no profile and states no provider', () => {
      const agent: Agent = {
        '@type': 'Software',
        model: 'gpt-4',
      };
      expect(renderAgentLabel(agent)).toBe('gpt-4');
    });

    it('falls back to name when both provider and model are absent', () => {
      const agent: Agent = {
        '@type': 'Software',
        name: 'Some Software',
      };
      expect(renderAgentLabel(agent)).toBe('Some Software');
    });

    it('falls back to its DID when it says nothing of itself, as a generator the record supplies', () => {
      const agent: Agent = {
        '@type': 'Software',
        '@id': 'did:web:example.com:agents:semiont-worker',
      };
      expect(renderAgentLabel(agent)).toBe('did:web:example.com:agents:semiont-worker');
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

  describe('Degraded shapes', () => {
    it('falls back to @id when name is empty', () => {
      const agent = {
        '@type': 'Person',
        '@id': 'did:web:example.com:users:bob%40example.com',
        name: '',
      } as unknown as Agent;
      expect(renderAgentLabel(agent)).toBe('did:web:example.com:users:bob%40example.com');
    });

    it('has no label when nothing identifies the agent', () => {
      const agent = { '@type': 'Person', name: '' } as unknown as Agent;
      expect(renderAgentLabel(agent)).toBeUndefined();
    });
  });
});

describe('an agent that names itself in no way', () => {
  const nameless = { '@type': 'Person' } as Agent;

  it('is left out of a list of labels', () => {
    const alice = { '@type': 'Person', name: 'Alice' } as Agent;

    expect(renderAgentLabels([alice, nameless])).toBe('Alice');
    expect(renderAgentLabels(nameless)).toBe('');
  });

  it('has no creator name', () => {
    expect(creatorName(nameless)).toBeUndefined();
    expect(creatorName(undefined)).toBeUndefined();
    expect(creatorName('did:web:example.com:users:bob')).toBe('did:web:example.com:users:bob');
  });
});
