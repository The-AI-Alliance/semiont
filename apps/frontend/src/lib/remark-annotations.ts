import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';
import type { VFile } from 'vfile';

interface Annotation {
  id: string;
  text: string;
  offset: number;
  length: number;
  type: 'highlight' | 'reference';
}

interface RemarkAnnotationsOptions {
  annotations: Annotation[];
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

        // Store as hProperties to survive remark → rehype transformation
        node.data.hProperties['data-annotations'] = JSON.stringify(overlapping);
        node.data.hProperties['data-node-start'] = nodeStart;
        node.data.hProperties['data-node-end'] = nodeEnd;
        node.data.hProperties['data-source'] = source;
      }
    });
  };
}
