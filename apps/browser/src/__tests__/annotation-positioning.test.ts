/**
 * Annotation Positioning Test
 *
 * Tests how AnnotateView determines which text to highlight based on
 * TextPositionSelector and TextQuoteSelector from W3C Web Annotations.
 *
 * This test reproduces a real-world case where the highlighted text
 * doesn't match the annotation's exact text.
 */

import { describe, it, expect } from 'vitest';

describe('Annotation Positioning - Real World Case', () => {
  // The actual content from the legal document
  const content = `Lampron, J.
Action by plaintiff Engineering Associates of New England, Inc., a New Hampshire corporation with a principal place of business in Manchester, against W. & L. E. Gurley, a New York corporation with a principal place of business in Troy, New York, later known as B & L Liquidating Corporation, to recover commissions allegedly earned under a sales representative agreement with Gurley. Service of plaintiff's writ, dated January 18, 1969, was made on the secretary of state pursuant to RSA 300:14 (1966), which was then in effect, and notice sent to Gurley at its office in Troy.
B & L Liquidating appeared specially and moved to dismiss plaintiff's action on the following grounds: (1) Defendant did not enter into a contract which was to be performed in whole or in part in New Hampshire; (2) defendant was not registered to do business and was not doing business in New Hampshire; and (3) Plaintiff's claim should have been brought in the New York court which was supervising the liquidation of B & L Liquidating, formerly W. & L. E. Gurley. Hearing before King, J., who reserved and transferred without ruling, on an agreed statement of facts, the question "whether the plaintiff has jurisdiction over and can sue B 8c L Liquidating Corporation, which was dissolved on January 21,1969."`;

  // The annotation from the backend
  const annotation = {
    "@context": "http://www.w3.org/ns/anno.jsonld",
    "type": "Annotation",
    "id": "https://ideal-fortnight-pjpg4rx4rc6jx9-4000.app.github.dev/annotations/Mt29etnqD4AAMV0r_UsJF",
    "motivation": "tagging",
    "target": {
      "type": "SpecificResource",
      "source": "https://ideal-fortnight-pjpg4rx4rc6jx9-4000.app.github.dev/resources/fa67e360958d4ccf7bad9639e429c18c",
      "selector": [
        {
          "type": "TextPositionSelector",
          "start": 1159,
          "end": 1301
        },
        {
          "type": "TextQuoteSelector",
          "exact": "the question \"whether the plaintiff has jurisdiction over and can sue B 8c L Liquidating Corporation, which was dissolved on January 21,1969.\"",
          "prefix": "without ruling, on an agreed statement of facts, ",
          "suffix": ""
        }
      ]
    },
    "body": [
      {
        "type": "TextualBody",
        "value": "Issue",
        "purpose": "tagging",
        "format": "text/plain",
        "language": "en"
      }
    ]
  };

  it('should extract exact text using TextPositionSelector', () => {
    const positionSelector = annotation.target.selector.find(
      (s: any) => s.type === 'TextPositionSelector'
    ) as any;

    const extractedText = content.substring(
      positionSelector.start,
      positionSelector.end
    );

    console.log('\n=== TextPositionSelector Extraction ===');
    console.log('Start:', positionSelector.start);
    console.log('End:', positionSelector.end);
    console.log('Extracted text:', JSON.stringify(extractedText));
    console.log('Length:', extractedText.length);

    // Check if it matches the exact text from TextQuoteSelector
    const quoteSelector = annotation.target.selector.find(
      (s: any) => s.type === 'TextQuoteSelector'
    ) as any;

    console.log('\n=== Expected (from TextQuoteSelector.exact) ===');
    console.log('Expected text:', JSON.stringify(quoteSelector.exact));
    console.log('Length:', quoteSelector.exact.length);

    expect(extractedText).toBe(quoteSelector.exact);
  });

  it('should find text using TextQuoteSelector with prefix/suffix context', () => {
    const quoteSelector = annotation.target.selector.find(
      (s: any) => s.type === 'TextQuoteSelector'
    ) as any;

    // Find the exact text in content
    const exactIndex = content.indexOf(quoteSelector.exact);

    console.log('\n=== TextQuoteSelector Search ===');
    console.log('Searching for:', JSON.stringify(quoteSelector.exact));
    console.log('Found at index:', exactIndex);

    if (exactIndex !== -1) {
      // Check if prefix matches
      const beforeText = content.substring(
        Math.max(0, exactIndex - quoteSelector.prefix.length),
        exactIndex
      );
      console.log('\n=== Prefix Validation ===');
      console.log('Expected prefix:', JSON.stringify(quoteSelector.prefix));
      console.log('Actual text before:', JSON.stringify(beforeText));
      console.log('Prefix matches:', beforeText.endsWith(quoteSelector.prefix));

      // Check if suffix matches
      const afterText = content.substring(
        exactIndex + quoteSelector.exact.length,
        Math.min(content.length, exactIndex + quoteSelector.exact.length + quoteSelector.suffix.length)
      );
      console.log('\n=== Suffix Validation ===');
      console.log('Expected suffix:', JSON.stringify(quoteSelector.suffix));
      console.log('Actual text after:', JSON.stringify(afterText));
      console.log('Suffix matches:', afterText.startsWith(quoteSelector.suffix));
    }

    expect(exactIndex).toBeGreaterThanOrEqual(0);
  });

  it('should verify TextPositionSelector and TextQuoteSelector point to same text', () => {
    const positionSelector = annotation.target.selector.find(
      (s: any) => s.type === 'TextPositionSelector'
    ) as any;

    const quoteSelector = annotation.target.selector.find(
      (s: any) => s.type === 'TextQuoteSelector'
    ) as any;

    // Extract using position
    const textFromPosition = content.substring(
      positionSelector.start,
      positionSelector.end
    );

    // Find using quote
    const indexFromQuote = content.indexOf(quoteSelector.exact);
    const textFromQuote = indexFromQuote >= 0
      ? content.substring(indexFromQuote, indexFromQuote + quoteSelector.exact.length)
      : null;

    console.log('\n=== Consistency Check ===');
    console.log('Text from position selector:', JSON.stringify(textFromPosition));
    console.log('Text from quote selector:', JSON.stringify(textFromQuote));
    console.log('Position start:', positionSelector.start);
    console.log('Quote index:', indexFromQuote);
    console.log('Match:', textFromPosition === textFromQuote);

    if (textFromPosition !== textFromQuote) {
      console.log('\n=== MISMATCH DETECTED ===');
      console.log('Position selector points to:', JSON.stringify(textFromPosition));
      console.log('Quote selector expects:', JSON.stringify(quoteSelector.exact));

      // Show what's around the position selector location
      const contextBefore = content.substring(
        Math.max(0, positionSelector.start - 50),
        positionSelector.start
      );
      const contextAfter = content.substring(
        positionSelector.end,
        Math.min(content.length, positionSelector.end + 50)
      );

      console.log('\nContext at position selector:');
      console.log('Before:', JSON.stringify(contextBefore));
      console.log('Selected:', JSON.stringify(textFromPosition));
      console.log('After:', JSON.stringify(contextAfter));
    }

    expect(textFromPosition).toBe(quoteSelector.exact);
  });

  it('should show character-by-character comparison if there is a mismatch', () => {
    const positionSelector = annotation.target.selector.find(
      (s: any) => s.type === 'TextPositionSelector'
    ) as any;

    const quoteSelector = annotation.target.selector.find(
      (s: any) => s.type === 'TextQuoteSelector'
    ) as any;

    const textFromPosition = content.substring(
      positionSelector.start,
      positionSelector.end
    );

    const expected = quoteSelector.exact;

    if (textFromPosition !== expected) {
      console.log('\n=== Character-by-Character Comparison ===');
      const maxLen = Math.max(textFromPosition.length, expected.length);

      for (let i = 0; i < maxLen; i++) {
        const actual = textFromPosition[i] || '(end)';
        const exp = expected[i] || '(end)';

        if (actual !== exp) {
          console.log(`Position ${i}:`);
          console.log(`  Actual: "${actual}" (code: ${actual.charCodeAt?.(0)})`);
          console.log(`  Expected: "${exp}" (code: ${exp.charCodeAt?.(0)})`);

          if (i < 5) {
            console.log('  First mismatch detected!');
          }
        }
      }
    }
  });

  it('should check if the prefix/suffix in the annotation are corrupted', () => {
    const quoteSelector = annotation.target.selector.find(
      (s: any) => s.type === 'TextQuoteSelector'
    ) as any;

    console.log('\n=== Checking Prefix/Suffix Quality ===');

    // The prefix seems truncated: "J., who reserved and transferred without ruling, on an agreed st"
    // Should probably be: "...statement of facts, "
    console.log('Prefix length:', quoteSelector.prefix.length);
    console.log('Prefix:', JSON.stringify(quoteSelector.prefix));
    console.log('Prefix ends with word boundary?', /[\s.,;:!?'"()\[\]{}<>\/\\]$/.test(quoteSelector.prefix));
    console.log('Prefix seems truncated?', quoteSelector.prefix.endsWith('st'));

    // The suffix also seems odd: "uary 21,1969."\nRSA 300:14 (1966) read in pertinent part as follows"
    // Should probably start at a word boundary
    console.log('\nSuffix length:', quoteSelector.suffix.length);
    console.log('Suffix:', JSON.stringify(quoteSelector.suffix));
    console.log('Suffix starts with word boundary?', /^[\s.,;:!?'"()\[\]{}<>\/\\]/.test(quoteSelector.suffix));
    console.log('Suffix seems truncated?', quoteSelector.suffix.startsWith('uary'));
  });
});
