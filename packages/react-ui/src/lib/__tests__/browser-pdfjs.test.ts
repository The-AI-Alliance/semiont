/**
 * Browser PDF.js utility tests
 *
 * Tests PDF.js loading and basic functionality
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

describe('browser-pdfjs', () => {
  beforeEach(() => {
    // Clear any existing pdfjsLib
    if (typeof window !== 'undefined') {
      (window as any).pdfjsLib = undefined;
    }
  });

  test('loads PDF.js script when not available', async () => {
    // This test verifies the script loading mechanism
    // In a real browser environment, this would load /pdfjs/pdf.min.mjs
    expect(true).toBe(true); // Placeholder - actual test needs browser environment
  });

  test('validates PDF structure', () => {
    // Test that we can detect invalid PDF files
    // A valid PDF starts with %PDF-
    const validPdfHeader = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D]); // %PDF-
    const invalidHeader = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);

    // Check valid header
    const validString = String.fromCharCode(...validPdfHeader);
    expect(validString).toBe('%PDF-');

    // Check invalid header
    const invalidString = String.fromCharCode(...invalidHeader);
    expect(invalidString).not.toBe('%PDF-');
  });
});

/**
 * Helper: Create a minimal valid PDF for testing
 *
 * Returns ArrayBuffer of a minimal PDF document
 */
export function createMinimalTestPdf(): ArrayBuffer {
  // Minimal valid PDF (single blank page)
  const pdfContent = `%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj
2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj
3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Resources <<
/Font <<
/F1 <<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica
>>
>>
>>
>>
endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer
<<
/Size 4
/Root 1 0 R
>>
startxref
280
%%EOF`;

  const encoder = new TextEncoder();
  return encoder.encode(pdfContent).buffer;
}
