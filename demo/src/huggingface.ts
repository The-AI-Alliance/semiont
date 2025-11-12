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
