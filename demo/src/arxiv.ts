/**
 * arXiv Paper Utilities
 *
 * Utilities for fetching papers from arXiv.org
 */

export interface ArxivPaper {
  id: string;
  title: string;
  abstract: string;
  authors: string[];
  published: string;
  updated: string;
  categories: string[];
  pdfUrl: string;
  arxivUrl: string;
}

/**
 * Fetch paper metadata from arXiv API
 * Uses the arXiv API: http://export.arxiv.org/api/query
 */
export async function fetchArxivPaper(arxivId: string): Promise<ArxivPaper> {
  // arXiv ID format: 1706.03762 or arXiv:1706.03762
  const cleanId = arxivId.replace('arXiv:', '');
  const url = `http://export.arxiv.org/api/query?id_list=${cleanId}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch arXiv paper: ${response.status}`);
  }

  const xml = await response.text();

  // Extract the <entry> section (contains the paper data)
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) {
    throw new Error('No entry found in arXiv response');
  }
  const entry = entryMatch[1];

  // Parse XML from entry (simple regex-based parser for this specific format)
  const extractTag = (tag: string, source: string): string => {
    const match = source.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return match ? match[1].trim() : '';
  };

  const extractAllTags = (tag: string, source: string): string[] => {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
    const matches = [];
    let match;
    while ((match = regex.exec(source)) !== null) {
      matches.push(match[1].trim());
    }
    return matches;
  };

  const title = extractTag('title', entry)
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const abstract = extractTag('summary', entry)
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract author names from <author><name>...</name></author> tags
  const authors = extractAllTags('name', entry);

  const published = extractTag('published', entry);
  const updated = extractTag('updated', entry);

  // Extract categories
  const categories = entry
    .match(/<category term="([^"]+)"/g)
    ?.map(m => m.match(/term="([^"]+)"/)?.[1] || '')
    .filter(Boolean) || [];

  const pdfUrl = `https://arxiv.org/pdf/${cleanId}.pdf`;
  const arxivUrl = `https://arxiv.org/abs/${cleanId}`;

  return {
    id: cleanId,
    title,
    abstract,
    authors,
    published,
    updated,
    categories,
    pdfUrl,
    arxivUrl,
  };
}

/**
 * Format arXiv paper as markdown document
 */
export function formatArxivPaper(paper: ArxivPaper): string {
  let markdown = `# ${paper.title}\n\n`;

  markdown += `**Authors:** ${paper.authors.join(', ')}\n\n`;
  markdown += `**arXiv ID:** ${paper.id}\n\n`;
  markdown += `**Published:** ${new Date(paper.published).toLocaleDateString()}\n\n`;

  if (paper.categories.length > 0) {
    markdown += `**Categories:** ${paper.categories.join(', ')}\n\n`;
  }

  markdown += `**Links:**\n`;
  markdown += `- [arXiv Abstract](${paper.arxivUrl})\n`;
  markdown += `- [PDF](${paper.pdfUrl})\n\n`;

  markdown += `---\n\n`;
  markdown += `## Abstract\n\n`;
  markdown += `${paper.abstract}\n`;

  return markdown;
}
