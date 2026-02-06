'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useTranslations } from '../../contexts/TranslationContext';
import { getSupportedShapes } from '../../lib/media-shapes';
import type { Annotator } from '../../lib/annotation-registry';
import './annotations.css';
import './annotation-entries.css';
import './references.css';

export type SelectionMotivation = 'linking' | 'highlighting' | 'assessing' | 'commenting' | 'tagging';
export type ClickAction = 'detail' | 'follow' | 'jsonld' | 'deleting';
export type ShapeType = 'rectangle' | 'circle' | 'polygon';

interface AnnotateToolbarProps {
  selectedMotivation: SelectionMotivation | null;
  selectedClick: ClickAction;
  onSelectionChange: (motivation: SelectionMotivation | null) => void;
  onClickChange: (motivation: ClickAction) => void;
  showSelectionGroup?: boolean;
  showDeleteButton?: boolean;
  showShapeGroup?: boolean;
  selectedShape?: ShapeType;
  onShapeChange?: (shape: ShapeType) => void;
  mediaType?: string | null;  // MIME type to determine supported shapes

  // Mode props
  annotateMode: boolean;
  onAnnotateModeToggle: () => void;

  // Annotators for emoji lookup
  annotators: Record<string, Annotator>;
}

interface DropdownGroupProps {
  label: string;
  collapsedContent: React.ReactNode;
  expandedContent: React.ReactNode;
  isExpanded: boolean;
  onHoverChange: (hovering: boolean) => void;
  onPin: () => void;
  containerRef: React.RefObject<HTMLDivElement>;
}

function DropdownGroup({
  label,
  collapsedContent,
  expandedContent,
  isExpanded,
  onHoverChange,
  onPin,
  containerRef,
}: DropdownGroupProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPin();
    }
  };

  return (
    <div
      className="semiont-dropdown-group"
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <div
        ref={containerRef}
        role="button"
        tabIndex={0}
        aria-haspopup="true"
        aria-expanded={isExpanded}
        aria-label={label}
        className="semiont-dropdown-trigger"
        onClick={onPin}
        onKeyDown={handleKeyDown}
      >
        {/* Always show collapsed content */}
        {collapsedContent}
      </div>

      {/* Expanded menu appears as dropdown below */}
      {isExpanded && (
        <div
          ref={dropdownRef}
          role="menu"
          aria-orientation="vertical"
          className="semiont-dropdown-menu"
        >
          <div className="semiont-dropdown-content">
            <div className="semiont-dropdown-header">
              {label}
            </div>
            {expandedContent}
          </div>
        </div>
      )}
    </div>
  );
}

export function AnnotateToolbar({
  selectedMotivation,
  selectedClick,
  onSelectionChange,
  onClickChange,
  showSelectionGroup = true,
  showDeleteButton = true,
  showShapeGroup = false,
  selectedShape = 'rectangle',
  onShapeChange,
  mediaType,
  annotateMode = false,
  onAnnotateModeToggle,
  annotators
}: AnnotateToolbarProps) {
  const t = useTranslations('AnnotateToolbar');

  // Helper to get emoji from annotators by motivation (with fallback for safety)
  const getMotivationEmoji = (motivation: SelectionMotivation): string => {
    const annotator = Object.values(annotators).find(a => a.motivation === motivation);
    return annotator?.iconEmoji || '❓';
  };

  // State for each group
  const [modeHovered, setModeHovered] = useState(false);
  const [modePinned, setModePinned] = useState(false);
  const [clickHovered, setClickHovered] = useState(false);
  const [clickPinned, setClickPinned] = useState(false);
  const [selectionHovered, setSelectionHovered] = useState(false);
  const [selectionPinned, setSelectionPinned] = useState(false);
  const [shapeHovered, setShapeHovered] = useState(false);
  const [shapePinned, setShapePinned] = useState(false);

  // Refs for each group
  const modeRef = useRef<HTMLDivElement>(null);
  const clickRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const shapeRef = useRef<HTMLDivElement>(null);

  // Expanded state = hover OR pinned
  const modeExpanded = modeHovered || modePinned;
  const clickExpanded = clickHovered || clickPinned;
  const selectionExpanded = selectionHovered || selectionPinned;
  const shapeExpanded = shapeHovered || shapePinned;

  // Click outside handler
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modePinned && modeRef.current && !modeRef.current.contains(event.target as Node)) {
        setModePinned(false);
      }
      if (clickPinned && clickRef.current && !clickRef.current.contains(event.target as Node)) {
        setClickPinned(false);
      }
      if (selectionPinned && selectionRef.current && !selectionRef.current.contains(event.target as Node)) {
        setSelectionPinned(false);
      }
      if (shapePinned && shapeRef.current && !shapeRef.current.contains(event.target as Node)) {
        setShapePinned(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [modePinned, clickPinned, selectionPinned, shapePinned]);

  // Escape key handler
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModePinned(false);
        setClickPinned(false);
        setSelectionPinned(false);
        setShapePinned(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  const handleSelectionClick = (motivation: SelectionMotivation | null) => {
    // If null is clicked, always deselect. Otherwise toggle.
    if (motivation === null) {
      onSelectionChange(null);
    } else {
      onSelectionChange(selectedMotivation === motivation ? null : motivation);
    }
    // Close dropdown after selection
    setSelectionPinned(false);
    setSelectionHovered(false);
  };

  const handleClickClick = (action: ClickAction) => {
    onClickChange(action);
    // Close dropdown after selection
    setClickPinned(false);
    setClickHovered(false);
  };

  const handleShapeClick = (shape: ShapeType) => {
    if (onShapeChange) {
      onShapeChange(shape);
    }
    // Close dropdown after selection
    setShapePinned(false);
    setShapeHovered(false);
  };

  const handleModeToggle = () => {
    onAnnotateModeToggle();
    setModePinned(false);
    setModeHovered(false);
  };

  const handleBrowseClick = () => {
    if (annotateMode) {
      handleModeToggle();
    }
  };

  const handleAnnotateClick = () => {
    if (!annotateMode) {
      handleModeToggle();
    }
  };

  // Render button with icon and label
  const renderButton = (
    icon: string,
    label: string,
    isSelected: boolean,
    onClick: () => void,
    isDelete: boolean = false
  ) => {
    return (
      <button
        role="menuitem"
        onClick={(e) => {
          e.stopPropagation(); // Prevent click from bubbling to parent container
          onClick();
        }}
        className="semiont-toolbar-menu-button"
        data-selected={isSelected}
        data-delete={isDelete}
        aria-pressed={isSelected}
        aria-label={label}
      >
        <span className="semiont-toolbar-menu-icon" aria-hidden="true">{icon}</span>
        <span className="semiont-toolbar-menu-label">{label}</span>
      </button>
    );
  };

  // Click actions data
  const clickActions: Array<{ action: ClickAction; icon: string; label: string; isDelete?: boolean }> = [
    { action: 'detail', icon: '🔍', label: t('detail') },
    { action: 'follow', icon: '➡️', label: t('follow') },
    { action: 'jsonld', icon: '🌐', label: t('jsonld') },
  ];

  if (showDeleteButton) {
    clickActions.push({ action: 'deleting', icon: '🗑️', label: t('deleting'), isDelete: true });
  }

  // Selection motivations data
  const selectionMotivations: Array<{ motivation: SelectionMotivation; label: string }> = [
    { motivation: 'linking', label: t('linking') },
    { motivation: 'highlighting', label: t('highlighting') },
    { motivation: 'assessing', label: t('assessing') },
    { motivation: 'commenting', label: t('commenting') },
    { motivation: 'tagging', label: t('tagging') },
  ];

  // Shape types data - filter based on media type
  const allShapeTypes: Array<{ shape: ShapeType; icon: string; label: string }> = [
    { shape: 'rectangle', icon: '▭', label: t('rectangle') },
    { shape: 'circle', icon: '○', label: t('circle') },
    { shape: 'polygon', icon: '⬡', label: t('polygon') },
  ];

  // Filter shapes based on media type (PDF only supports rectangles)
  const supportedShapes = getSupportedShapes(mediaType);
  const shapeTypes = allShapeTypes.filter(st => supportedShapes.includes(st.shape));

  return (
    <div className="semiont-annotate-toolbar">
      {/* Click Group */}
      <DropdownGroup
        label={t('clickGroup')}
        isExpanded={clickExpanded}
        onHoverChange={setClickHovered}
        onPin={() => setClickPinned(!clickPinned)}
        containerRef={clickRef}
        collapsedContent={
          <div className="semiont-dropdown-display">
            <span className="semiont-dropdown-icon">
              {clickActions.find(a => a.action === selectedClick)?.icon}
            </span>
            <span className="semiont-dropdown-label">
              {clickActions.find(a => a.action === selectedClick)?.label}
            </span>
          </div>
        }
        expandedContent={
          <>
            {clickActions.map(({ action, icon, label, isDelete }) => (
              <React.Fragment key={action}>
                {renderButton(icon, label, selectedClick === action, () => handleClickClick(action), isDelete)}
              </React.Fragment>
            ))}
          </>
        }
      />

      {/* Separator */}
      <div className="semiont-toolbar-separator" />

      {/* Mode Group */}
      <DropdownGroup
        label={t('modeGroup')}
        isExpanded={modeExpanded}
        onHoverChange={setModeHovered}
        onPin={() => setModePinned(!modePinned)}
        containerRef={modeRef}
        collapsedContent={
          <div className="semiont-dropdown-display">
            <span className="semiont-dropdown-icon">{annotateMode ? '✏️' : '📖'}</span>
            <span className="semiont-dropdown-label">
              {annotateMode ? t('annotate') : t('browse')}
            </span>
          </div>
        }
        expandedContent={
          <>
            {renderButton('📖', t('browse'), !annotateMode, handleBrowseClick)}
            {renderButton('✏️', t('annotate'), annotateMode, handleAnnotateClick)}
          </>
        }
      />

      {/* Separator */}
      {showSelectionGroup && <div className="semiont-toolbar-separator" />}

      {/* Selection Group */}
      {showSelectionGroup && (
        <DropdownGroup
          label={t('selectionGroup')}
          isExpanded={selectionExpanded}
          onHoverChange={setSelectionHovered}
          onPin={() => setSelectionPinned(!selectionPinned)}
          containerRef={selectionRef}
          collapsedContent={
            <div className="semiont-dropdown-display">
              <span className="semiont-dropdown-icon">{selectedMotivation ? getMotivationEmoji(selectedMotivation) : '—'}</span>
              <span className="semiont-dropdown-label">
                {selectedMotivation
                  ? selectionMotivations.find(m => m.motivation === selectedMotivation)?.label
                  : t('none')
                }
              </span>
            </div>
          }
          expandedContent={
            <>
              {/* None option to deselect */}
              {renderButton(
                '—',
                t('none'),
                selectedMotivation === null,
                () => handleSelectionClick(null)
              )}
              {selectionMotivations.map(({ motivation, label }) => (
                <React.Fragment key={motivation}>
                  {renderButton(
                    getMotivationEmoji(motivation),
                    label,
                    selectedMotivation === motivation,
                    () => handleSelectionClick(motivation)
                  )}
                </React.Fragment>
              ))}
            </>
          }
        />
      )}

      {/* Separator */}
      {showShapeGroup && <div className="semiont-toolbar-separator" />}

      {/* Shape Group */}
      {showShapeGroup && shapeTypes.length > 0 && (
        <DropdownGroup
          label={t('shapeGroup')}
          isExpanded={shapeExpanded}
          onHoverChange={setShapeHovered}
          onPin={() => setShapePinned(!shapePinned)}
          containerRef={shapeRef}
          collapsedContent={
            <div className="semiont-dropdown-display">
              <span className="semiont-dropdown-icon">
                {shapeTypes.find(s => s.shape === selectedShape)?.icon}
              </span>
              <span className="semiont-dropdown-label">
                {shapeTypes.find(s => s.shape === selectedShape)?.label}
              </span>
            </div>
          }
          expandedContent={
            <>
              {shapeTypes.map(({ shape, icon, label }) => (
                <React.Fragment key={shape}>
                  {renderButton(icon, label, selectedShape === shape, () => handleShapeClick(shape))}
                </React.Fragment>
              ))}
            </>
          }
        />
      )}
    </div>
  );
}