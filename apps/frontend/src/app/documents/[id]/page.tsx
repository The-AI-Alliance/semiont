"use client";

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { apiService } from '@/lib/api-client';
import { AnnotatedMarkdownRenderer } from '@/components/AnnotatedMarkdownRenderer';
import { SelectionPopup } from '@/components/SelectionPopup';
import { PageLayout } from '@/components/PageLayout';
import type { Document, Selection } from '@/lib/api-client';
import { 
  mapBackendToFrontendSelection, 
  type HighlightsApiResponse, 
  type ReferencesApiResponse,
  type SelectionsApiResponse
} from '@/lib/api-types';

export default function DocumentPage() {
  const params = useParams();
  const router = useRouter();
  const { data: session, status } = useSession();
  const documentId = params?.id as string;

  const [document, setDocument] = useState<Document | null>(null);
  const [highlights, setHighlights] = useState<any[]>([]);
  const [references, setReferences] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Selection popup state
  const [selectedText, setSelectedText] = useState<string>('');
  const [selectionPosition, setSelectionPosition] = useState<{ start: number; end: number } | null>(null);
  const [showSelectionPopup, setShowSelectionPopup] = useState(false);

  // Load document and its selections
  useEffect(() => {
    if (status === 'loading') return;
    if (!session?.backendToken) {
      router.push('/auth/signin');
      return;
    }

    loadDocument();
    loadSelections();
  }, [documentId, session, status]);

  const loadDocument = async () => {
    try {
      setLoading(true);
      const response = await apiService.documents.get(documentId);
      setDocument(response.document);
      setError(null);
    } catch (err) {
      console.error('Failed to load document:', err);
      setError('Failed to load document');
    } finally {
      setLoading(false);
    }
  };

  const loadSelections = async () => {
    try {
      // Load highlights with proper typing
      const highlightsResponse = await apiService.selections.getHighlights(documentId) as unknown as HighlightsApiResponse | SelectionsApiResponse;
      const highlightData = 'highlights' in highlightsResponse ? highlightsResponse.highlights : highlightsResponse.selections;
      const mappedHighlights = highlightData.map(mapBackendToFrontendSelection);
      setHighlights(mappedHighlights);

      // Load references with proper typing
      const referencesResponse = await apiService.selections.getReferences(documentId) as unknown as ReferencesApiResponse | SelectionsApiResponse;
      const referenceData = 'references' in referencesResponse ? referencesResponse.references : referencesResponse.selections;
      const mappedReferences = referenceData.map(mapBackendToFrontendSelection);
      
      console.log('Loaded references with proper types:', mappedReferences);
      setReferences(mappedReferences);
    } catch (err) {
      console.error('Failed to load selections:', err);
    }
  };

  const handleTextSelection = (text: string, position: { start: number; end: number }) => {
    setSelectedText(text);
    setSelectionPosition(position);
    setShowSelectionPopup(true);
  };

  const handleWikiLinkClick = async (pageName: string) => {
    // Search for a document with this name
    try {
      const response = await apiService.documents.search(pageName, 1);
      if (response.documents.length > 0 && response.documents[0]) {
        router.push(`/documents/${response.documents[0].id}`);
      } else {
        // Optionally create a new document or show a "not found" message
        if (confirm(`Document "${pageName}" not found. Would you like to create it?`)) {
          const newDoc = await apiService.documents.create({
            name: pageName,
            content: `# ${pageName}\n\nThis page was created from a wiki link.`,
            contentType: 'text/markdown'
          });
          router.push(`/documents/${newDoc.document.id}`);
        }
      }
    } catch (err) {
      console.error('Failed to navigate to wiki link:', err);
    }
  };

  const handleCreateHighlight = async () => {
    if (!selectionPosition) return;

    try {
      await apiService.selections.saveAsHighlight({
        documentId,
        text: selectedText,
        position: selectionPosition
      });
      
      // Reload selections
      await loadSelections();
      
      // Close popup
      setShowSelectionPopup(false);
      setSelectedText('');
      setSelectionPosition(null);
    } catch (err) {
      console.error('Failed to create highlight:', err);
      alert('Failed to create highlight');
    }
  };

  const handleCreateReference = async (targetDocId?: string, entityType?: string, referenceType?: string) => {
    if (!selectionPosition) return;

    try {
      // First create the selection
      const response = await apiService.selections.create({
        documentId,
        text: selectedText,
        position: selectionPosition,
        type: 'reference'
      });

      console.log('Full selection create response:', response);
      console.log('Response keys:', Object.keys(response));
      console.log('Response type:', typeof response);

      // The response should be the selection directly with an id property
      // But let's check all possible structures
      let selectionId: string | undefined;
      
      if (typeof response === 'object' && response !== null) {
        // Check various possible response structures
        selectionId = (response as any).id || 
                     (response as any).selectionId || 
                     (response as any).selection?.id ||
                     (response as any).data?.id ||
                     (response as any).data?.selection?.id;
      }
      
      if (!selectionId) {
        console.error('Could not extract selection ID from response:', response);
        throw new Error('Failed to get selection ID from response');
      }

      console.log('Extracted selection ID:', selectionId);

      // If we have a target document, resolve it
      if (targetDocId) {
        console.log('Resolving to document:', targetDocId, 'with selection:', selectionId);
        const resolveData: { selectionId: string; targetDocumentId: string; referenceType?: string } = {
          selectionId: selectionId,
          targetDocumentId: targetDocId
        };
        if (referenceType) {
          resolveData.referenceType = referenceType;
        }
        await apiService.selections.resolveToDocument(resolveData);
      }

      // Reload selections
      await loadSelections();
      
      // Close popup
      setShowSelectionPopup(false);
      setSelectedText('');
      setSelectionPosition(null);
    } catch (err) {
      console.error('Failed to create reference - Full error:', err);
      if (err instanceof Error) {
        console.error('Error message:', err.message);
        console.error('Error stack:', err.stack);
      }
      alert(`Failed to create reference: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  if (loading) {
    return (
      <PageLayout>
        <div className="flex items-center justify-center py-20">
          <p className="text-gray-600 dark:text-gray-300">Loading document...</p>
        </div>
      </PageLayout>
    );
  }

  if (error || !document) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-red-600 dark:text-red-400 mb-4">{error || 'Document not found'}</p>
          <button
            onClick={() => router.push('/')}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Go Home
          </button>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout className="bg-gray-50 dark:bg-gray-900">
      {/* Document Header */}
      <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
              {document.name}
            </h2>
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Last updated: {new Date(document.updatedAt).toLocaleDateString()}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Document Content */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
          <AnnotatedMarkdownRenderer
            content={document.content}
            highlights={highlights}
            references={references}
            onWikiLinkClick={handleWikiLinkClick}
            onTextSelect={handleTextSelection}
            onHighlightClick={(highlight) => {
              // Optional: Show tooltip or info about the highlight
              console.log('Highlight clicked:', highlight);
            }}
            onReferenceClick={(reference) => {
              // Navigate to referenced document if available
              if (reference.referencedDocumentId) {
                router.push(`/documents/${reference.referencedDocumentId}`);
              } else {
                console.log('Reference clicked:', reference);
              }
            }}
          />
        </div>

        {/* Annotation Legend */}
        {(highlights.length > 0 || references.length > 0) && (
          <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Annotations</h3>
            <div className="flex gap-4 text-xs">
              {highlights.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-4 h-4 bg-yellow-200 dark:bg-yellow-900/40 rounded"></span>
                  <span className="text-gray-600 dark:text-gray-400">{highlights.length} Highlight{highlights.length !== 1 ? 's' : ''}</span>
                </div>
              )}
              {references.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-4 h-4 bg-gradient-to-r from-cyan-200 to-blue-200 dark:from-cyan-900/40 dark:to-blue-900/40 rounded-md border border-cyan-400/30 dark:border-cyan-600/30"></span>
                  <span className="text-gray-600 dark:text-gray-400">{references.length} Reference{references.length !== 1 ? 's' : ''}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Selection Popup */}
      {showSelectionPopup && (
        <SelectionPopup
          selectedText={selectedText}
          onCreateHighlight={handleCreateHighlight}
          onCreateReference={handleCreateReference}
          onClose={() => {
            setShowSelectionPopup(false);
            setSelectedText('');
            setSelectionPosition(null);
          }}
        />
      )}
    </PageLayout>
  );
}