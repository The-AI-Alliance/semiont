/**
 * Hugging Face Dataset Fetcher
 *
 * Utilities for fetching data from Hugging Face datasets.
 */

export interface HuggingFaceDocument {
  text: string;
  name?: string;
  [key: string]: any;
}

/**
 * Document info with structured metadata
 */
export interface DocumentInfo {
  title: string;
  content: string;
  metadata: {
    decisionDate?: string;
    docketNumber?: string;
    citation?: string;
    [key: string]: any;
  };
}

export interface HuggingFaceDatasetOptions {
  dataset: string;
  split?: string;
  offset?: number;
  length?: number;
}

/**
 * Fetch documents from a Hugging Face dataset
 * Uses the Hugging Face Datasets Server API
 */
export async function fetchHuggingFaceDataset(
  options: HuggingFaceDatasetOptions
): Promise<HuggingFaceDocument[]> {
  const {
    dataset,
    split = 'train',
    offset = 0,
    length = 100,
  } = options;

  // Use the Hugging Face Datasets Server API
  // https://huggingface.co/docs/datasets-server/
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=default&split=${split}&offset=${offset}&length=${length}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch dataset: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.rows || !Array.isArray(data.rows)) {
    throw new Error('Invalid response format from Hugging Face API');
  }

  // Extract the row data
  return data.rows.map((item: any) => item.row);
}

/**
 * Fetch a specific number of documents starting from offset
 */
export async function fetchFirstNDocuments(
  dataset: string,
  count: number,
  split: string = 'train'
): Promise<HuggingFaceDocument[]> {
  return fetchHuggingFaceDataset({
    dataset,
    split,
    offset: 0,
    length: count,
  });
}

/**
 * Convert free-law dataset document to DocumentInfo
 * Handles the specific schema from free-law datasets (nh, ca, etc.)
 */
export function convertLegalCaseDocument(
  doc: HuggingFaceDocument,
  index: number
): DocumentInfo {
  // Create a readable title from case name
  const title = doc.name_abbreviation || doc.name || `Case ${index + 1}`;
  const decisionDate = doc.decision_date || 'Unknown Date';

  // Build citation if available
  let citation = '';
  if (doc.citations && Array.isArray(doc.citations) && doc.citations.length > 0) {
    citation = doc.citations[0].cite || '';
  } else if (doc.volume && doc.reporter && doc.first_page) {
    citation = `${doc.volume} ${doc.reporter} ${doc.first_page}`;
  }

  return {
    title: `${title} (${decisionDate})`,
    content: doc.text || '',
    metadata: {
      decisionDate: doc.decision_date,
      docketNumber: doc.docket_number,
      citation,
    },
  };
}
