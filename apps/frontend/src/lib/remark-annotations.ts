import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';
import type { VFile } from 'vfile';

/**
 * Simplified annotation format for remark plugin.
 * This is NOT the W3C Annotation - it's a pre-processed format with offset/length
 * for efficient markdown text processing.
 */
export interface PreparedAnnotation {
  id: string;
  exact: string;
  offset: number;  // Character offset in source text (start position)
  length: number;  // Length of annotated text (not end position!)
  type: 'highlight' | 'reference' | 'assessment' | 'comment';
  source: string | null; // For references - the linked document ID (null for stubs)
}

interface RemarkAnnotationsOptions {
  annotations: PreparedAnnotation[];
}

export function remarkAnnotations(options: RemarkAnnotationsOptions) {
  const { annotations } = options;

  return (tree: Root, file: VFile) => {
    const source = String(file);

    visit(tree, (node) => {
      if (!node.position) return;

      const nodeStart = node.position.start.offset;
      const nodeEnd = node.position.end.offset;

      if (nodeStart === undefined || nodeEnd === undefined) return;

      // Find annotations that overlap with this node using range intersection
      const overlapping = annotations.filter(ann => {
        const annStart = ann.offset;
        const annEnd = ann.offset + ann.length;
        return annStart < nodeEnd && annEnd > nodeStart;
      });

      if (overlapping.length > 0) {
        if (!node.data) node.data = {};
        if (!node.data.hProperties) node.data.hProperties = {};

        // Store only annotations JSON - rehype plugin will have source via closure
        node.data.hProperties['data-annotations'] = JSON.stringify(overlapping);
      }
    });
  };
}
