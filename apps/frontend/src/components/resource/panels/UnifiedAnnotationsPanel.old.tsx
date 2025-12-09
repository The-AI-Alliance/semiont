'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { HighlightPanel } from './HighlightPanel';
import { ReferencesPanel } from './ReferencesPanel';
import { AssessmentPanel } from './AssessmentPanel';
import { CommentsPanel } from './CommentsPanel';
import { TaggingPanel } from './TaggingPanel';

type Annotation = components['schemas']['Annotation'];

type AnnotationType = 'highlights' | 'references' | 'assessments' | 'comments' | 'tags';

interface UnifiedAnnotationsPanelProps {
  // Annotation data
  highlights: Annotation[];
  references: Annotation[];
  assessments: Annotation[];
  comments: Annotation[];
  tags: Annotation[];

  // Click handlers
  onHighlightClick: (annotation: Annotation) => void;
  onReferenceClick: (annotation: Annotation) => void;
  onAssessmentClick: (annotation: Annotation) => void;
  onCommentClick: (annotation: Annotation) => void;
  onTagClick: (annotation: Annotation) => void;

  // Hover handlers
  onHighlightHover?: (annotationId: string | null) => void;
  onReferenceHover?: (annotationId: string | null) => void;
  onAssessmentHover?: (annotationId: string | null) => void;
  onCommentHover?: (commentId: string | null) => void;
  onTagHover?: (tagId: string | null) => void;

  // Focused/hovered state
  focusedHighlightId: string | null;
  focusedReferenceId: string | null;
  focusedAssessmentId: string | null;
  focusedCommentId: string | null;
  focusedTagId: string | null;

  hoveredHighlightId?: string | null;
  hoveredReferenceId?: string | null;
  hoveredAssessmentId?: string | null;
  hoveredCommentId?: string | null;
  hoveredTagId?: string | null;

  // Mode
  annotateMode?: boolean;

  // Detection handlers
  onDetectHighlights?: (instructions?: string) => void | Promise<void>;
  onDetectAssessments?: (instructions?: string) => void | Promise<void>;
  onDetectComments?: (instructions?: string, tone?: string) => void | Promise<void>;
  onDetectTags?: (schemaId: string, categories: string[]) => void | Promise<void>;

  // Detection state
  isDetectingHighlights?: boolean;
  isDetectingAssessments?: boolean;
  isDetectingComments?: boolean;
  isDetectingTags?: boolean;

  highlightDetectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;

  assessmentDetectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;

  commentDetectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;

  tagDetectionProgress?: {
    status: string;
    percentage?: number;
    currentCategory?: string;
    processedCategories?: number;
    totalCategories?: number;
    message?: string;
  } | null;

  // Comment-specific
  onUpdateComment?: (annotationId: string, newText: string) => void;
  onCreateComment?: (commentText: string) => void;
  pendingCommentSelection?: {
    exact: string;
    start: number;
    end: number;
  } | null;

  // Tag-specific
  onCreateTag?: (selection: { exact: string; start: number; end: number }, schemaId: string, category: string) => void | Promise<void>;
  pendingTagSelection?: {
    exact: string;
    start: number;
    end: number;
  } | null;

  // Reference-specific
  onConvertToReference?: (highlightId: string, entityType?: string) => void;
  onConvertToHighlight?: (referenceId: string) => void;
  generatingReferenceId?: string | null;
  allEntityTypes?: string[];
  onDetectEntityReferences?: (selectedTypes: string[]) => void;
  onCancelReferenceDetection?: () => void;
  isDetectingReferences?: boolean;
  referenceDetectionProgress?: any;
  onGenerateDocument?: (title: string) => void;
  onSearchDocuments?: (referenceId: string, searchTerm: string) => void;
  onUpdateReference?: (referenceId: string, updates: any) => void;
  mediaType?: string;
  referencedBy?: any[];
  referencedByLoading?: boolean;

  // Initial tab (optional)
  initialTab?: AnnotationType;
  resourceId?: string;
}

export function UnifiedAnnotationsPanel(props: UnifiedAnnotationsPanelProps) {
  const t = useTranslations('UnifiedAnnotationsPanel');

  // Load tab from localStorage (per-resource)
  const [activeTab, setActiveTab] = useState<AnnotationType>(() => {
    if (typeof window === 'undefined') return props.initialTab || 'highlights';

    const storageKey = props.resourceId
      ? `annotations-tab-${props.resourceId}`
      : 'annotations-tab-global';

    const stored = localStorage.getItem(storageKey);
    if (stored && ['highlights', 'references', 'assessments', 'comments', 'tags'].includes(stored)) {
      return stored as AnnotationType;
    }

    return props.initialTab || 'highlights';
  });

  // Persist tab selection
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const storageKey = props.resourceId
      ? `annotations-tab-${props.resourceId}`
      : 'annotations-tab-global';

    localStorage.setItem(storageKey, activeTab);
  }, [activeTab, props.resourceId]);

  const handleTabClick = (tab: AnnotationType) => {
    setActiveTab(tab);
  };

  // Tab button styling
  const tabButtonClass = (tab: AnnotationType) => {
    const isActive = activeTab === tab;
    return `
      px-3 py-1.5 text-sm font-medium rounded-md transition-colors
      ${isActive
        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
      }
    `.trim();
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Tab Navigation */}
      <div className="flex flex-wrap gap-1 p-2 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => handleTabClick('highlights')}
          className={tabButtonClass('highlights')}
          aria-pressed={activeTab === 'highlights'}
        >
          🟡 {t('highlights')} ({props.highlights.length})
        </button>
        <button
          onClick={() => handleTabClick('references')}
          className={tabButtonClass('references')}
          aria-pressed={activeTab === 'references'}
        >
          🔵 {t('references')} ({props.references.length})
        </button>
        <button
          onClick={() => handleTabClick('assessments')}
          className={tabButtonClass('assessments')}
          aria-pressed={activeTab === 'assessments'}
        >
          🔴 {t('assessments')} ({props.assessments.length})
        </button>
        <button
          onClick={() => handleTabClick('comments')}
          className={tabButtonClass('comments')}
          aria-pressed={activeTab === 'comments'}
        >
          💬 {t('comments')} ({props.comments.length})
        </button>
        <button
          onClick={() => handleTabClick('tags')}
          className={tabButtonClass('tags')}
          aria-pressed={activeTab === 'tags'}
        >
          🏷️ {t('tags')} ({props.tags.length})
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'highlights' && (
          <HighlightPanel
            highlights={props.highlights}
            onHighlightClick={props.onHighlightClick}
            focusedHighlightId={props.focusedHighlightId}
            hoveredHighlightId={props.hoveredHighlightId ?? null}
            {...(props.onHighlightHover ? { onHighlightHover: props.onHighlightHover } : {})}
            {...(props.onDetectHighlights ? { onDetectHighlights: props.onDetectHighlights } : {})}
            {...(props.isDetectingHighlights ? { isDetecting: props.isDetectingHighlights } : {})}
            {...(props.highlightDetectionProgress ? { detectionProgress: props.highlightDetectionProgress } : {})}
            {...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})}
          />
        )}

        {activeTab === 'references' && (
          <ReferencesPanel
            allEntityTypes={props.allEntityTypes || []}
            isDetecting={props.isDetectingReferences || false}
            detectionProgress={props.referenceDetectionProgress}
            onDetect={props.onDetectEntityReferences || (() => {})}
            onCancelDetection={props.onCancelReferenceDetection || (() => {})}
            references={props.references}
            {...(props.onReferenceClick ? { onReferenceClick: props.onReferenceClick } : {})}
            {...(props.focusedReferenceId ? { focusedReferenceId: props.focusedReferenceId } : {})}
            hoveredReferenceId={props.hoveredReferenceId ?? null}
            {...(props.onReferenceHover ? { onReferenceHover: props.onReferenceHover } : {})}
            {...(props.onGenerateDocument ? { onGenerateDocument: props.onGenerateDocument } : {})}
            {...(props.onSearchDocuments ? { onSearchDocuments: props.onSearchDocuments } : {})}
            {...(props.onUpdateReference ? { onUpdateReference: props.onUpdateReference } : {})}
            {...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})}
            {...(props.mediaType ? { mediaType: props.mediaType } : {})}
            {...(props.referencedBy ? { referencedBy: props.referencedBy } : {})}
            {...(props.referencedByLoading !== undefined ? { referencedByLoading: props.referencedByLoading } : {})}
          />
        )}

        {activeTab === 'assessments' && (
          <AssessmentPanel
            assessments={props.assessments}
            onAssessmentClick={props.onAssessmentClick}
            focusedAssessmentId={props.focusedAssessmentId}
            hoveredAssessmentId={props.hoveredAssessmentId ?? null}
            {...(props.onAssessmentHover ? { onAssessmentHover: props.onAssessmentHover } : {})}
            {...(props.onDetectAssessments ? { onDetectAssessments: props.onDetectAssessments } : {})}
            {...(props.isDetectingAssessments ? { isDetecting: props.isDetectingAssessments } : {})}
            {...(props.assessmentDetectionProgress ? { detectionProgress: props.assessmentDetectionProgress } : {})}
            {...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})}
          />
        )}

        {activeTab === 'comments' && props.onUpdateComment && (
          <CommentsPanel
            comments={props.comments}
            onCommentClick={props.onCommentClick}
            onUpdateComment={props.onUpdateComment}
            {...(props.onCreateComment ? { onCreateComment: props.onCreateComment } : {})}
            focusedCommentId={props.focusedCommentId}
            hoveredCommentId={props.hoveredCommentId ?? null}
            {...(props.onCommentHover ? { onCommentHover: props.onCommentHover } : {})}
            {...(props.pendingCommentSelection ? { pendingSelection: props.pendingCommentSelection } : {})}
            {...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})}
            {...(props.onDetectComments ? { onDetectComments: props.onDetectComments } : {})}
            {...(props.isDetectingComments ? { isDetecting: props.isDetectingComments } : {})}
            {...(props.commentDetectionProgress ? { detectionProgress: props.commentDetectionProgress } : {})}
          />
        )}

        {activeTab === 'tags' && (
          <TaggingPanel
            tags={props.tags}
            onTagClick={props.onTagClick}
            focusedTagId={props.focusedTagId}
            hoveredTagId={props.hoveredTagId ?? null}
            {...(props.onTagHover ? { onTagHover: props.onTagHover } : {})}
            {...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})}
            {...(props.onDetectTags ? { onDetectTags: props.onDetectTags } : {})}
            {...(props.onCreateTag ? { onCreateTag: props.onCreateTag } : {})}
            {...(props.isDetectingTags ? { isDetecting: props.isDetectingTags } : {})}
            {...(props.tagDetectionProgress ? { detectionProgress: props.tagDetectionProgress } : {})}
            {...(props.pendingTagSelection ? { pendingSelection: props.pendingTagSelection } : {})}
          />
        )}
      </div>
    </div>
  );
}
