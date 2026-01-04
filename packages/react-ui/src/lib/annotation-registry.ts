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

import type { MutableRefObject } from 'react';
import type { components } from '@semiont/api-client';
import { isHighlight, isComment, isReference, isTag, entityType } from '@semiont/api-client';
import type { CacheManager } from '../types/CacheManager';

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation']; // Already defined in api-client with all 13 W3C motivations!

/**
 * Detection configuration for SSE-based annotation detection
 */
export interface DetectionConfig {
  // SSE method name (e.g., 'detectAnnotations', 'detectHighlights')
  sseMethod: 'detectAnnotations' | 'detectHighlights' | 'detectAssessments' | 'detectComments' | 'detectTags';

  // How to extract count from completion result
  countField: 'foundCount' | 'createdCount' | 'tagsCreated';

  // Plural display name for messages (e.g., 'entity references', 'highlights')
  displayNamePlural: string;

  // Singular display name for messages (e.g., 'entity reference', 'highlight')
  displayNameSingular: string;

  // Function to format request parameters for display in progress UI
  // Returns array of { label, value } pairs to show what was requested
  formatRequestParams?: (args: any[]) => Array<{ label: string; value: string }>;
}

/**
 * Annotator: Encapsulates all motivation-specific behavior
 * Handles clicks, hovers, detection, and other operations for one annotation type
 *
 * Metadata is static (defined in registry), handlers are injected at runtime (from page.tsx)
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

  // Handlers (injected at runtime)
  handlers?: {
    onClick?: (annotation: Annotation) => void;
    onHover?: (annotationId: string | null) => void;
    onDetect?: (...args: any[]) => void | Promise<void>;
    onUpdate?: (annotationId: string, ...args: any[]) => void | Promise<void>;
    onCreate?: (...args: any[]) => void | Promise<void>;
  };
}

/**
 * Registry of all annotators (motivation handlers)
 * Metadata is defined here, handlers are injected at runtime
 */
export const ANNOTATORS: Record<string, Annotator> = {
  highlight: {
    motivation: 'highlighting',
    internalType: 'highlight',
    displayName: 'Highlight',
    description: 'Mark text for attention',
    className: 'rounded px-0.5 cursor-pointer transition-all duration-200 bg-yellow-200 hover:bg-yellow-300 text-gray-900 dark:bg-yellow-900/50 dark:hover:bg-yellow-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-yellow-500/60 dark:outline-offset-1',
    iconEmoji: '🟡',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann) => isHighlight(ann),
    announceOnCreate: 'Highlight created',
    detection: {
      sseMethod: 'detectHighlights',
      countField: 'createdCount',
      displayNamePlural: 'highlights',
      displayNameSingular: 'highlight',
      formatRequestParams: (args) => {
        const params: Array<{ label: string; value: string }> = [];
        if (args[0]) {
          params.push({ label: 'Instructions', value: args[0] });
        }
        // args[2] is density (args[1] is tone which is unused for highlights)
        if (args[2] !== undefined) {
          params.push({ label: 'Density', value: `${args[2]} per 2000 words` });
        }
        return params;
      }
    }
  },

  comment: {
    motivation: 'commenting',
    internalType: 'comment',
    displayName: 'Comment',
    description: 'Add a comment about the text',
    className: 'rounded px-0.5 cursor-pointer transition-all duration-200 hover:bg-gray-100 dark:hover:bg-gray-800 outline outline-2 outline-dashed outline-gray-900 dark:outline-gray-100 outline-offset-1',
    iconEmoji: '💬',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann) => isComment(ann),
    announceOnCreate: 'Comment created',
    detection: {
      sseMethod: 'detectComments',
      countField: 'createdCount',
      displayNamePlural: 'comments',
      displayNameSingular: 'comment',
      formatRequestParams: (args) => {
        const params: Array<{ label: string; value: string }> = [];
        if (args[0]) {
          params.push({ label: 'Instructions', value: args[0] });
        }
        if (args[1]) {
          params.push({ label: 'Tone', value: args[1] });
        }
        if (args[2] !== undefined) {
          params.push({ label: 'Density', value: `${args[2]} per 2000 words` });
        }
        return params;
      }
    }
  },

  assessment: {
    motivation: 'assessing',
    internalType: 'assessment',
    displayName: 'Assessment',
    description: 'Provide evaluation or assessment',
    className: 'red-underline cursor-pointer transition-all duration-200 hover:opacity-80',
    iconEmoji: '🔴',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann) => ann.motivation === 'assessing',
    announceOnCreate: 'Assessment created',
    detection: {
      sseMethod: 'detectAssessments',
      countField: 'createdCount',
      displayNamePlural: 'assessments',
      displayNameSingular: 'assessment',
      formatRequestParams: (args) => {
        const params: Array<{ label: string; value: string }> = [];
        if (args[0]) {
          params.push({ label: 'Instructions', value: args[0] });
        }
        if (args[1]) {
          params.push({ label: 'Tone', value: args[1] });
        }
        if (args[2] !== undefined) {
          params.push({ label: 'Density', value: `${args[2]} per 2000 words` });
        }
        return params;
      }
    }
  },

  reference: {
    motivation: 'linking',
    internalType: 'reference',
    displayName: 'Reference',
    description: 'Link to another resource',
    className: 'rounded px-0.5 cursor-pointer transition-all duration-200 bg-gradient-to-r from-cyan-200 to-blue-200 hover:from-cyan-300 hover:to-blue-300 text-gray-900 dark:from-blue-900/50 dark:to-cyan-900/50 dark:hover:from-blue-900/60 dark:hover:to-cyan-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-cyan-500/60 dark:outline-offset-1',
    iconEmoji: '🔵',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann) => isReference(ann),
    announceOnCreate: 'Reference created',
    detection: {
      sseMethod: 'detectAnnotations',
      countField: 'foundCount',
      displayNamePlural: 'entity references',
      displayNameSingular: 'entity reference',
      formatRequestParams: (args) => {
        const params: Array<{ label: string; value: string }> = [];
        if (args[0] && Array.isArray(args[0]) && args[0].length > 0) {
          params.push({ label: 'Entity Types', value: args[0].join(', ') });
        }
        // args[1] is includeDescriptiveReferences: boolean
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
    className: 'rounded px-0.5 cursor-pointer transition-all duration-200 bg-gradient-to-r from-orange-200 to-amber-200 hover:from-orange-300 hover:to-amber-300 text-gray-900 dark:from-orange-900/50 dark:to-amber-900/50 dark:hover:from-orange-900/60 dark:hover:to-amber-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-orange-500/60 dark:outline-offset-1',
    iconEmoji: '🏷️',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann) => isTag(ann),
    announceOnCreate: 'Tag created',
    detection: {
      sseMethod: 'detectTags',
      countField: 'tagsCreated',
      displayNamePlural: 'tags',
      displayNameSingular: 'tag',
      formatRequestParams: (args) => {
        const params: Array<{ label: string; value: string }> = [];
        if (args[0]) {
          // Map schema ID to friendly name
          const schemaNames: Record<string, string> = {
            'legal-irac': 'Legal (IRAC)',
            'scientific-imrad': 'Scientific (IMRAD)',
            'argument-toulmin': 'Argument (Toulmin)'
          };
          params.push({ label: 'Schema', value: schemaNames[args[0]] || args[0] });
        }
        if (args[1] && Array.isArray(args[1]) && args[1].length > 0) {
          params.push({ label: 'Categories', value: args[1].join(', ') });
        }
        return params;
      }
    }
  }
};

/**
 * Get annotator for an annotation by checking all registered types
 * Returns null if annotation doesn't match any registered type
 */
export function getAnnotator(annotation: Annotation): Annotator | null {
  for (const annotator of Object.values(ANNOTATORS)) {
    if (annotator.matchesAnnotation(annotation)) {
      return annotator;
    }
  }
  return null;
}

/**
 * Get CSS className for an annotation
 * Falls back to highlight style if no match found
 */
export function getAnnotationClassName(annotation: Annotation): string {
  const annotator = getAnnotator(annotation);
  return annotator?.className ?? ANNOTATORS.highlight!.className;
}

/**
 * Get internal type string for an annotation (e.g., 'highlight', 'comment')
 * Falls back to 'highlight' if no match found
 */
export function getAnnotationInternalType(annotation: Annotation): string {
  const annotator = getAnnotator(annotation);
  return annotator?.internalType ?? 'highlight';
}

/**
 * Group annotations by their internal type
 * Returns a record with keys like 'highlight', 'comment', 'assessment', 'reference'
 * Each value is an array of annotations of that type
 */
export function groupAnnotationsByType(annotations: Annotation[]): Record<string, Annotation[]> {
  const groups: Record<string, Annotation[]> = {};

  // Initialize empty arrays for all registered types
  for (const annotator of Object.values(ANNOTATORS)) {
    groups[annotator.internalType] = [];
  }

  // Group annotations by type
  for (const ann of annotations) {
    const annotator = getAnnotator(ann);
    if (annotator) {
      groups[annotator.internalType]!.push(ann);
    }
  }

  return groups;
}

/**
 * Create a copy of annotators with handlers injected
 * Use this in page.tsx to inject runtime handlers into the registry
 */
export function withHandlers(
  handlers: Record<string, Annotator['handlers']>
): Record<string, Annotator> {
  const annotatorsWithHandlers: Record<string, Annotator> = {};

  for (const [key, annotator] of Object.entries(ANNOTATORS)) {
    annotatorsWithHandlers[key] = {
      ...annotator,
      ...(handlers[key] ? { handlers: handlers[key] } : {})
    };
  }

  return annotatorsWithHandlers;
}

/**
 * Generic detection handler factory
 * Creates a detection handler for any annotator with detection config
 *
 * This eliminates the need for motivation-specific detection handlers
 * (handleDetectHighlights, handleDetectAssessments, etc.)
 */
export function createDetectionHandler(
  annotator: Annotator,
  context: {
    client: any; // ApiClient from @semiont/api-client
    rUri: any; // ResourceUri
    setDetectingMotivation: (motivation: Motivation | null) => void;
    setMotivationDetectionProgress: (progress: any) => void;
    detectionStreamRef: MutableRefObject<any>;
    cacheManager: CacheManager;
    showSuccess: (message: string) => void;
    showError: (message: string) => void;
  }
) {
  const { detection } = annotator;
  if (!detection) {
    throw new Error(`Annotator ${annotator.internalType} does not support detection`);
  }

  return async (...args: any[]) => {
    if (!context.client) return;

    // Format request parameters for display (if formatter provided)
    const requestParams = detection.formatRequestParams ? detection.formatRequestParams(args) : [];

    context.setDetectingMotivation(annotator.motivation);
    context.setMotivationDetectionProgress({
      status: 'started',
      message: `Starting ${detection.displayNameSingular} detection...`,
      requestParams
    });

    try {
      // Call the appropriate SSE method
      const sseClient = context.client.sse;

      // Transform arguments for different detection methods
      let stream;
      if (detection.sseMethod === 'detectAnnotations') {
        // args[0] is selectedEntityTypes: string[], args[1] is includeDescriptiveReferences: boolean
        const selectedTypes = args[0] || [];
        const includeDescriptiveReferences = args[1];
        stream = sseClient.detectAnnotations(context.rUri, {
          entityTypes: selectedTypes.map((type: string) => entityType(type)),
          includeDescriptiveReferences
        });
      } else if (detection.sseMethod === 'detectTags') {
        // args[0] is schemaId: string, args[1] is categories: string[]
        const schemaId = args[0];
        const categories = args[1] || [];
        stream = sseClient.detectTags(context.rUri, {
          schemaId,
          categories
        });
      } else if (detection.sseMethod === 'detectHighlights') {
        // args[0] is instructions: string, args[1] is tone (unused for highlights), args[2] is density: number
        const instructions = args[0];
        const density = args[2];
        stream = sseClient.detectHighlights(context.rUri, {
          instructions,
          density
        });
      } else if (detection.sseMethod === 'detectComments') {
        // args[0] is instructions: string, args[1] is tone: string, args[2] is density: number
        const instructions = args[0];
        const tone = args[1];
        const density = args[2];
        stream = sseClient.detectComments(context.rUri, {
          instructions,
          tone,
          density
        });
      } else if (detection.sseMethod === 'detectAssessments') {
        // args[0] is instructions: string, args[1] is tone: string, args[2] is density: number
        const instructions = args[0];
        const tone = args[1];
        const density = args[2];
        stream = sseClient.detectAssessments(context.rUri, {
          instructions,
          tone,
          density
        });
      } else {
        throw new Error(`Unknown detection method: ${detection.sseMethod}`);
      }

      context.detectionStreamRef.current = stream;

      stream.onProgress((progress: any) => {
        // Handle reference detection's special progress format
        if (detection.sseMethod === 'detectAnnotations') {
          context.setMotivationDetectionProgress({
            status: progress.status,
            message: progress.message ||
              (progress.currentEntityType
                ? `Detecting ${progress.currentEntityType}...`
                : `Processing ${progress.processedEntityTypes} of ${progress.totalEntityTypes} entity types...`),
            processedCategories: progress.processedEntityTypes,
            totalCategories: progress.totalEntityTypes,
            ...(progress.currentEntityType && { currentCategory: progress.currentEntityType }),
            requestParams
          });
        } else {
          // Standard progress format for other types (tags, etc.)
          context.setMotivationDetectionProgress({
            status: progress.status,
            percentage: progress.percentage,
            message: progress.message,
            ...(progress.currentCategory && { currentCategory: progress.currentCategory }),
            ...(progress.processedCategories !== undefined && { processedCategories: progress.processedCategories }),
            ...(progress.totalCategories !== undefined && { totalCategories: progress.totalCategories }),
            requestParams
          });
        }
      });

      stream.onComplete((result: any) => {
        const count = result[detection.countField];
        context.setMotivationDetectionProgress({
          status: 'complete',
          percentage: 100,
          message: `Created ${count} ${count === 1 ? detection.displayNameSingular : detection.displayNamePlural}`,
          requestParams
        });
        context.setDetectingMotivation(null);
        context.detectionStreamRef.current = null;
        context.cacheManager.invalidateAnnotations(context.rUri);
        context.cacheManager.invalidateEvents(context.rUri);
        context.showSuccess(`Created ${count} ${count === 1 ? detection.displayNameSingular : detection.displayNamePlural}`);
      });

      stream.onError((error: any) => {
        context.setMotivationDetectionProgress(null);
        context.setDetectingMotivation(null);
        context.detectionStreamRef.current = null;
        context.showError(`${annotator.displayName} detection failed: ${error.message}`);
      });
    } catch (error) {
      context.setDetectingMotivation(null);
      context.setMotivationDetectionProgress(null);
      context.detectionStreamRef.current = null;
      context.showError(`Failed to start ${detection.displayNameSingular} detection`);
    }
  };
}

/**
 * Generic detection cancellation handler
 * Cancels any active detection stream
 */
export function createCancelDetectionHandler(context: {
  detectionStreamRef: MutableRefObject<any>;
  setDetectingMotivation: (motivation: Motivation | null) => void;
  setMotivationDetectionProgress: (progress: any) => void;
}) {
  return () => {
    if (context.detectionStreamRef.current) {
      context.detectionStreamRef.current.close();
      context.detectionStreamRef.current = null;
    }
    context.setDetectingMotivation(null);
    context.setMotivationDetectionProgress(null);
  };
}
