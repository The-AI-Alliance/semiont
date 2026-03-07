/**
 * Centralized annotation type registry
 *
 * Single source of truth for W3C annotation motivation metadata including:
 * - Visual styling (CSS classes)
 * - Behavior flags (clickable, hover, side panel)
 * - Type guards (motivation matching)
 * - Accessibility (screen reader announcements)
 * - Runtime handlers (click, hover, detect, update, create)
 *
 * Per CLAUDE.md: This is the ONLY place to define annotation type metadata.
 * No aliasing, wrappers, or compatibility layers elsewhere.
 */

import type { components } from '@semiont/core';
import { isHighlight, isComment, isReference, isTag } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation']; // Already defined in api-client with all 13 W3C motivations!

/**
 * Detection configuration for SSE-based annotation detection
 */
export interface DetectionConfig {
  // SSE method name (e.g., 'detectReferences', 'detectHighlights')
  sseMethod: 'detectReferences' | 'detectHighlights' | 'detectAssessments' | 'detectComments' | 'detectTags';

  // How to extract count from completion result
  countField: 'foundCount' | 'createdCount' | 'tagsCreated';

  // Plural display name for messages (e.g., 'entity references', 'highlights')
  displayNamePlural: string;

  // Singular display name for messages (e.g., 'entity reference', 'highlight')
  displayNameSingular: string;

  // Function to format request parameters for display in progress UI
  // Returns array of { label, value } pairs to show what was requested
  formatRequestParams?: (args: unknown[]) => Array<{ label: string; value: string }>;
}

/**
 * Creation configuration - describes how to create annotations of this type
 */
export interface CreateConfig {
  // How to build the annotation body from the creation arguments
  bodyBuilder: 'empty' | 'text' | 'entityTag' | 'dualTag';

  // Whether to refetch annotations after creation
  refetchAfter: boolean;

  // Optional success message template (for tags)
  successMessage?: string;
}

/**
 * Annotator: Encapsulates all motivation-specific behavior
 * Handles clicks, hovers, detection, and other operations for one annotation type
 */
export interface Annotator {
  // Metadata (static)
  motivation: Motivation;
  internalType: string;
  displayName: string;
  description: string;

  // Visual styling
  className: string;
  iconEmoji?: string;

  // Behavior flags
  isClickable: boolean;
  hasHoverInteraction: boolean;
  hasSidePanel: boolean;

  // Type guard function
  matchesAnnotation: (annotation: Annotation) => boolean;

  // Accessibility
  announceOnCreate: string;

  // Detection configuration (optional - only for types that support AI detection)
  detection?: DetectionConfig;

  // Creation configuration - describes how to create this annotation type
  create: CreateConfig;
}

/**
 * Static annotator definitions - single source of truth
 */
export const ANNOTATORS: Record<string, Annotator> = {
  highlight: {
    motivation: 'highlighting',
    internalType: 'highlight',
    displayName: 'Highlight',
    description: 'Mark text for attention',
    className: 'annotation-highlight',
    iconEmoji: '🟡',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann: Annotation) => isHighlight(ann),
    announceOnCreate: 'Highlight created',
    create: {
      bodyBuilder: 'empty',
      refetchAfter: false
    },
    detection: {
      sseMethod: 'detectHighlights',
      countField: 'createdCount',
      displayNamePlural: 'highlights',
      displayNameSingular: 'highlight',
      formatRequestParams: (args: unknown[]) => {
        const params: Array<{ label: string; value: string }> = [];
        if (typeof args[0] === 'string' && args[0]) params.push({ label: 'Instructions', value: args[0] });
        if (typeof args[2] === 'number') params.push({ label: 'Density', value: `${args[2]} per 2000 words` });
        return params;
      }
    }
  },
  comment: {
    motivation: 'commenting',
    internalType: 'comment',
    displayName: 'Comment',
    description: 'Add a comment about the text',
    className: 'annotation-comment',
    iconEmoji: '💬',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann: Annotation) => isComment(ann),
    announceOnCreate: 'Comment created',
    create: {
      bodyBuilder: 'text',
      refetchAfter: false
    },
    detection: {
      sseMethod: 'detectComments',
      countField: 'createdCount',
      displayNamePlural: 'comments',
      displayNameSingular: 'comment',
      formatRequestParams: (args: unknown[]) => {
        const params: Array<{ label: string; value: string }> = [];
        if (typeof args[0] === 'string' && args[0]) params.push({ label: 'Instructions', value: args[0] });
        if (typeof args[1] === 'string' && args[1]) params.push({ label: 'Tone', value: args[1] });
        if (typeof args[2] === 'number') params.push({ label: 'Density', value: `${args[2]} per 2000 words` });
        return params;
      }
    }
  },
  assessment: {
    motivation: 'assessing',
    internalType: 'assessment',
    displayName: 'Assessment',
    description: 'Provide evaluation or assessment',
    className: 'annotation-assessment',
    iconEmoji: '🔴',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann: Annotation) => ann.motivation === 'assessing',
    announceOnCreate: 'Assessment created',
    create: {
      bodyBuilder: 'text',
      refetchAfter: false
    },
    detection: {
      sseMethod: 'detectAssessments',
      countField: 'createdCount',
      displayNamePlural: 'assessments',
      displayNameSingular: 'assessment',
      formatRequestParams: (args: unknown[]) => {
        const params: Array<{ label: string; value: string }> = [];
        if (typeof args[0] === 'string' && args[0]) params.push({ label: 'Instructions', value: args[0] });
        if (typeof args[1] === 'string' && args[1]) params.push({ label: 'Tone', value: args[1] });
        if (typeof args[2] === 'number') params.push({ label: 'Density', value: `${args[2]} per 2000 words` });
        return params;
      }
    }
  },
  reference: {
    motivation: 'linking',
    internalType: 'reference',
    displayName: 'Reference',
    description: 'Link to another resource',
    className: 'annotation-reference',
    iconEmoji: '🔵',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann: Annotation) => isReference(ann),
    announceOnCreate: 'Reference created',
    create: {
      bodyBuilder: 'entityTag',
      refetchAfter: true
    },
    detection: {
      sseMethod: 'detectReferences',
      countField: 'foundCount',
      displayNamePlural: 'entity references',
      displayNameSingular: 'entity reference',
      formatRequestParams: (args: unknown[]) => {
        const params: Array<{ label: string; value: string }> = [];
        const types = args[0];
        if (Array.isArray(types) && types.length > 0) {
          params.push({ label: 'Entity Types', value: types.join(', ') });
        }
        if (args[1] === true) {
          params.push({ label: 'Include Descriptive References', value: 'Yes' });
        }
        return params;
      }
    }
  },
  tag: {
    motivation: 'tagging',
    internalType: 'tag',
    displayName: 'Tag',
    description: 'Structural role annotation',
    className: 'annotation-tag',
    iconEmoji: '🏷️',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann: Annotation) => isTag(ann),
    announceOnCreate: 'Tag created',
    create: {
      bodyBuilder: 'dualTag',
      refetchAfter: false,
      successMessage: 'Tag "{value}" created'
    },
    detection: {
      sseMethod: 'detectTags',
      countField: 'tagsCreated',
      displayNamePlural: 'tags',
      displayNameSingular: 'tag',
      formatRequestParams: (args: unknown[]) => {
        const params: Array<{ label: string; value: string }> = [];
        if (typeof args[0] === 'string' && args[0]) {
          const schemaNames: Record<string, string> = {
            'legal-irac': 'Legal (IRAC)',
            'scientific-imrad': 'Scientific (IMRAD)',
            'argument-toulmin': 'Argument (Toulmin)'
          };
          params.push({ label: 'Schema', value: schemaNames[args[0]] || args[0] });
        }
        const categories = args[1];
        if (Array.isArray(categories) && categories.length > 0) {
          params.push({ label: 'Categories', value: categories.join(', ') });
        }
        return params;
      }
    }
  }
};

