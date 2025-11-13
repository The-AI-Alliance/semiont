/**
 * Legal Citation Detection
 *
 * Utilities for detecting legal citations using the Python eyecite library
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export interface LegalCitation {
  text: string;
  start: number;
  end: number;
  type: string;
}

export interface CitationDetectionResult {
  citations: LegalCitation[];
}

/**
 * Detect legal citations in text using Python eyecite library
 * Calls detect_citations.py script via subprocess
 */
export async function detectCitations(text: string): Promise<LegalCitation[]> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const scriptPath = join(__dirname, '..', 'detect_citations.py');

  return new Promise((resolve, reject) => {
    const python = spawn('python3', [scriptPath]);

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Citation detection failed: ${stderr}`));
        return;
      }

      try {
        const result: CitationDetectionResult = JSON.parse(stdout);
        resolve(result.citations);
      } catch (error) {
        reject(new Error(`Failed to parse citation detection output: ${error}`));
      }
    });

    // Write text to stdin and close
    python.stdin.write(text);
    python.stdin.end();
  });
}
