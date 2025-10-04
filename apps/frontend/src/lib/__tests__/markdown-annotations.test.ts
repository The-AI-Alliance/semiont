import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { remarkAnnotations } from '../remark-annotations';
import { rehypeRenderAnnotations } from '../rehype-render-annotations';

describe('Markdown Annotations', () => {
  describe('Basic annotation rendering', () => {
    it('should render annotations on plain text', async () => {
      const markdown = `Zeus was the king of the gods.`;
      const annotations = [
        { id: 'ann-1', text: 'Zeus', offset: 0, length: 4, type: 'reference' as const }
      ];

      const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkAnnotations, { annotations })
        .use(remarkRehype)
        .use(rehypeRenderAnnotations)
        .use(rehypeStringify)
        .process(markdown);

      const html = String(result);

      // Should contain annotation span
      expect(html).toContain('data-annotation-id="ann-1"');
      expect(html).toContain('Zeus');
      // Should contain reference styling
      expect(html).toContain('border-b-2 border-blue-500');
    });
  });

  describe('Multi-paragraph plain text (realistic use case)', () => {
    const markdown = `In the beginning, Ouranos and Gaia held sway over Heaven and Earth. And manifold children were born unto them, of whom were Cronos, and Okeanos, and the Titans, and the Giants.

But Cronos cast down his father Ouranos, and ruled in his stead, until Zeus his son cast him down in his turn, and became King of Gods and men.

Then were the Titans divided, for some had good will unto Cronos, and others unto Zeus; until Prometheus, son of the Titan Iapetos, by wise counsel, gave the victory to Zeus.

But Zeus held the race of mortal men in scorn, and was fain to destroy them from the face of the earth; yet Prometheus loved them, and gave secretly to them the gift of fire, and arts whereby they could prosper upon the earth.`;

    // Helper to find text offset
    function findOffset(str: string, searchText: string, occurrence = 1): number {
      let index = -1;
      for (let i = 0; i < occurrence; i++) {
        index = str.indexOf(searchText, index + 1);
      }
      return index;
    }

    const annotations = [
      { id: 'ann-1', text: 'Ouranos', offset: findOffset(markdown, 'Ouranos', 1), length: 7, type: 'reference' as const },
      { id: 'ann-2', text: 'Gaia', offset: findOffset(markdown, 'Gaia', 1), length: 4, type: 'reference' as const },
      { id: 'ann-3', text: 'Cronos', offset: findOffset(markdown, 'Cronos', 1), length: 6, type: 'reference' as const },
      { id: 'ann-4', text: 'Ouranos', offset: findOffset(markdown, 'Ouranos', 2), length: 7, type: 'reference' as const },
      { id: 'ann-5', text: 'Zeus', offset: findOffset(markdown, 'Zeus', 1), length: 4, type: 'reference' as const },
      { id: 'ann-6', text: 'Cronos', offset: findOffset(markdown, 'Cronos', 2), length: 6, type: 'reference' as const },
      { id: 'ann-7', text: 'Zeus', offset: findOffset(markdown, 'Zeus', 2), length: 4, type: 'reference' as const },
      { id: 'ann-8', text: 'Prometheus', offset: findOffset(markdown, 'Prometheus', 1), length: 10, type: 'reference' as const },
      { id: 'ann-9', text: 'Zeus', offset: findOffset(markdown, 'Zeus', 3), length: 4, type: 'highlight' as const },
      { id: 'ann-10', text: 'Zeus', offset: findOffset(markdown, 'Zeus', 4), length: 4, type: 'reference' as const },
      { id: 'ann-11', text: 'Prometheus', offset: findOffset(markdown, 'Prometheus', 2), length: 10, type: 'reference' as const },
    ];

    it('should have correct offsets for all annotations', () => {
      // Verify each annotation points to the correct text
      annotations.forEach(ann => {
        const actualText = markdown.substring(ann.offset, ann.offset + ann.length);
        expect(actualText).toBe(ann.text);
      });
    });

    it('should render all annotations correctly', async () => {
      const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkAnnotations, { annotations })
        .use(remarkRehype)
        .use(rehypeRenderAnnotations)
        .use(rehypeStringify)
        .process(markdown);

      const html = String(result);

      // All annotations should be present
      annotations.forEach(ann => {
        expect(html).toContain(`data-annotation-id="${ann.id}"`);
      });

      // Should contain both reference and highlight styles
      expect(html).toContain('border-b-2 border-blue-500'); // reference style
      expect(html).toContain('bg-yellow-200'); // highlight style
    });

    it('should not repeat text', async () => {
      const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkAnnotations, { annotations })
        .use(remarkRehype)
        .use(rehypeRenderAnnotations)
        .use(rehypeStringify)
        .process(markdown);

      const html = String(result);

      // Check for the pathological case from earlier failed attempts
      // Text should NOT be repeated multiple times in a row
      expect(html).not.toContain('ZeusZeusZeus');
      expect(html).not.toContain('OuranosOuranosOuranos');
      expect(html).not.toContain('PrometheusPrometheusPrometheus');

      // Each name should appear correctly
      expect(html).toContain('Ouranos');
      expect(html).toContain('Zeus');
      expect(html).toContain('Prometheus');
    });

    it('should handle overlapping annotations in same paragraph', async () => {
      const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkAnnotations, { annotations })
        .use(remarkRehype)
        .use(rehypeRenderAnnotations)
        .use(rehypeStringify)
        .process(markdown);

      const html = String(result);

      // First paragraph has multiple annotations
      expect(html).toContain('data-annotation-id="ann-1"'); // Ouranos
      expect(html).toContain('data-annotation-id="ann-2"'); // Gaia
      expect(html).toContain('data-annotation-id="ann-3"'); // Cronos (first)

      // All should be in separate spans
      const ann1Match = html.match(/<span[^>]*data-annotation-id="ann-1"[^>]*>([^<]*)<\/span>/);
      const ann2Match = html.match(/<span[^>]*data-annotation-id="ann-2"[^>]*>([^<]*)<\/span>/);
      const ann3Match = html.match(/<span[^>]*data-annotation-id="ann-3"[^>]*>([^<]*)<\/span>/);

      expect(ann1Match?.[1]).toBe('Ouranos');
      expect(ann2Match?.[1]).toBe('Gaia');
      expect(ann3Match?.[1]).toBe('Cronos');
    });

    it('should handle multiple occurrences of same name', async () => {
      const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkAnnotations, { annotations })
        .use(remarkRehype)
        .use(rehypeRenderAnnotations)
        .use(rehypeStringify)
        .process(markdown);

      const html = String(result);

      // Zeus appears 4 times
      const zeusAnnotations = annotations.filter(a => a.text === 'Zeus');
      expect(zeusAnnotations.length).toBe(4);

      // All 4 should be in the HTML
      zeusAnnotations.forEach(ann => {
        expect(html).toContain(`data-annotation-id="${ann.id}"`);
      });
    });

    it('should differentiate between highlight and reference types', async () => {
      const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkAnnotations, { annotations })
        .use(remarkRehype)
        .use(rehypeRenderAnnotations)
        .use(rehypeStringify)
        .process(markdown);

      const html = String(result);

      // ann-9 is a highlight (third Zeus) - should have yellow background
      expect(html).toContain('data-annotation-id="ann-9"');
      expect(html).toContain('data-annotation-type="highlight"');
      expect(html).toContain('bg-yellow-200');

      // ann-10 is a reference (fourth Zeus) - should have blue border
      expect(html).toContain('data-annotation-id="ann-10"');
      expect(html).toContain('data-annotation-type="reference"');
      expect(html).toContain('border-b-2 border-blue-500');
    });
  });

  describe('Complex markdown (stress test)', () => {
    it('should handle annotations on text with bold markdown', async () => {
      // Annotation on "Zeus" which appears inside **Zeus**
      const markdown = `The god **Zeus** ruled from Olympus.`;

      // "Zeus" appears at offset 10 in source (after "The god **")
      // The text node in AST has position 10-14, even though parent <strong> is at 8-16
      const annotations = [
        { id: 'ann-1', text: 'Zeus', offset: 10, length: 4, type: 'reference' as const }
      ];

      const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkAnnotations, { annotations })
        .use(remarkRehype)
        .use(rehypeRenderAnnotations)
        .use(rehypeStringify)
        .process(markdown);

      const html = String(result);

      console.log('\n=== BOLD MARKDOWN TEST ===');
      console.log('Source:', markdown);
      console.log('Annotation offset:', annotations[0]!.offset, 'text:', markdown.substring(10, 14));
      console.log('HTML:', html);

      // This will likely fail because the text node inside <strong> has different offsets
      // The source at 11-15 is "Zeus" but the rendered text has no ** markers
      expect(html).toContain('data-annotation-id="ann-1"');
    });

    it('should handle annotations on text with italic markdown', async () => {
      const markdown = `The goddess *Athena* was wise.`;

      // "Athena" appears at offset 13 in source (after "The goddess *")
      const annotations = [
        { id: 'ann-1', text: 'Athena', offset: 13, length: 6, type: 'reference' as const }
      ];

      const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkAnnotations, { annotations })
        .use(remarkRehype)
        .use(rehypeRenderAnnotations)
        .use(rehypeStringify)
        .process(markdown);

      const html = String(result);

      console.log('\n=== ITALIC MARKDOWN TEST ===');
      console.log('Source:', markdown);
      console.log('Annotation offset:', annotations[0]!.offset, 'text:', markdown.substring(13, 19));
      console.log('HTML:', html);

      expect(html).toContain('data-annotation-id="ann-1"');
    });

    it('should handle annotations on text with links', async () => {
      const markdown = `Read about [Zeus](https://example.com/zeus) for more.`;

      // "Zeus" appears at offset 12 in source (after "Read about [")
      const annotations = [
        { id: 'ann-1', text: 'Zeus', offset: 12, length: 4, type: 'reference' as const }
      ];

      const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkAnnotations, { annotations })
        .use(remarkRehype)
        .use(rehypeRenderAnnotations)
        .use(rehypeStringify)
        .process(markdown);

      const html = String(result);

      console.log('\n=== LINK MARKDOWN TEST ===');
      console.log('Source:', markdown);
      console.log('Annotation offset:', annotations[0]!.offset, 'text:', markdown.substring(12, 16));
      console.log('HTML:', html);

      expect(html).toContain('data-annotation-id="ann-1"');
    });

    it('should handle annotations spanning element boundaries', async () => {
      const markdown = `The mighty **Zeus** and **Hera** ruled together.`;

      // Annotate "Zeus and Hera" - spans across two separate <strong> elements
      // This tests if we can handle annotations that span element boundaries
      // "Zeus" text node is at offset 12-16, "Hera" text node is at offset 26-30
      // We want to annotate from 'Z' (12) through 'a' (29), which is "Zeus and Hera" rendered
      // But this crosses element boundaries in a complex way - may not be fully supported
      const annotations = [
        { id: 'ann-1', text: 'Zeus and Hera', offset: 12, length: 18, type: 'highlight' as const }
      ];

      const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkAnnotations, { annotations })
        .use(remarkRehype)
        .use(rehypeRenderAnnotations)
        .use(rehypeStringify)
        .process(markdown);

      const html = String(result);

      console.log('\n=== SPANNING BOUNDARIES TEST ===');
      console.log('Source:', markdown);
      console.log('Annotation offset:', annotations[0]!.offset, 'length:', annotations[0]!.length);
      console.log('Annotation text in source:', markdown.substring(14, 31));
      console.log('HTML:', html);

      // This one is particularly challenging - the annotation spans across element boundaries
      expect(html).toContain('data-annotation-id="ann-1"');
    });

    it('should handle mixed markdown complexity', async () => {
      const markdown = `**Zeus**, _the king_, ruled [Olympus](https://example.com).`;

      // Annotate just "Zeus" (inside bold) - starts at position 2 (after **)
      // Annotate "the king" (inside italic) - starts at position 11 (after _)
      // Annotate "Olympus" (inside link) - starts at position 29 (after [)
      const annotations = [
        { id: 'ann-1', text: 'Zeus', offset: 2, length: 4, type: 'reference' as const },
        { id: 'ann-2', text: 'the king', offset: 11, length: 8, type: 'highlight' as const },
        { id: 'ann-3', text: 'Olympus', offset: 29, length: 7, type: 'reference' as const },
      ];

      const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkAnnotations, { annotations })
        .use(remarkRehype)
        .use(rehypeRenderAnnotations)
        .use(rehypeStringify)
        .process(markdown);

      const html = String(result);

      // All annotations should render correctly
      expect(html).toContain('data-annotation-id="ann-1"'); // Zeus in bold
      expect(html).toContain('data-annotation-id="ann-2"'); // the king in italic
      expect(html).toContain('data-annotation-id="ann-3"'); // Olympus in link

      // Verify annotation types
      expect(html).toContain('data-annotation-type="reference"');
      expect(html).toContain('data-annotation-type="highlight"');
    });
  });
});
