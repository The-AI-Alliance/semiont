import { useEffect } from 'react';
import type { KnowledgeBaseRoot, KnowledgeBasesResult } from '../lib/launcher-bridge';

export type KnowledgeBasesState =
  | { status: 'loading' }
  | { status: 'result'; result: KnowledgeBasesResult };

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  root?: KnowledgeBaseRoot;
}

function makeTree(roots: KnowledgeBaseRoot[]): TreeNode {
  const tree: TreeNode = { name: '', children: new Map() };
  for (const root of roots) {
    const normalized = root.path.replaceAll('\\', '/');
    const drive = normalized.match(/^[A-Za-z]:/u)?.[0];
    const segments = normalized.split('/').filter(Boolean);
    if (drive !== undefined) segments[0] = drive;
    else if (normalized.startsWith('/')) segments.unshift('/');
    let node = tree;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { name: segment, children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.root = root;
  }
  return tree;
}

export function KnowledgeBasesModal({
  state,
  onRefresh,
  onClose,
}: {
  state: KnowledgeBasesState;
  onRefresh: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const tree = state.status === 'result' ? makeTree(state.result.roots) : null;
  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal config--knowledge-bases" role="dialog" aria-modal="true" aria-labelledby="knowledge-bases-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="knowledge-bases-title">Knowledge Bases</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close Knowledge Bases">×</button>
        </header>
        <p className="knowledge-bases__intro">Local knowledge base folders remembered by the Semiont launcher.</p>
        {state.status === 'loading' ? (
          <p className="knowledge-bases__empty">Reading roots.json…</p>
        ) : (
          <>
            <p className="knowledge-bases__source">{state.result.stateFile}</p>
            {state.result.error !== null ? (
              <pre className="knowledge-bases__error">Could not read roots.json: {state.result.error}</pre>
            ) : state.result.roots.length === 0 ? (
              <p className="knowledge-bases__empty">No local knowledge bases are recorded yet.</p>
            ) : (
              <div className="knowledge-bases__tree" role="tree" aria-label="Local knowledge bases by folder">
                <TreeChildren node={tree!} depth={0} />
              </div>
            )}
          </>
        )}
        <footer className="knowledge-bases__footer">
          <button type="button" className="kb__connect" onClick={onRefresh}>Refresh</button>
        </footer>
      </section>
    </div>
  );
}

function TreeChildren({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <ul className="knowledge-bases__branch" role="group">
      {[...node.children.values()].map((child) => (
        <li className="knowledge-bases__node" role="treeitem" aria-expanded={child.children.size > 0} key={child.name}>
          <div className={`knowledge-bases__folder${child.root === undefined ? '' : ' knowledge-bases__folder--root'}`} style={{ paddingLeft: `${depth * 1.1}rem` }}>
            <FolderIcon />
            <span>{child.name}</span>
          </div>
          {child.root !== undefined && <RootDetails root={child.root} depth={depth + 1} />}
          {child.children.size > 0 && <TreeChildren node={child} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

function RootDetails({ root, depth }: { root: KnowledgeBaseRoot; depth: number }) {
  const details = [
    root.did,
    root.siteName,
    root.lastUsed ? `last used ${root.lastUsed.slice(0, 10)}` : undefined,
    root.lastStarted ? `last started ${root.lastStarted.slice(0, 10)}` : undefined,
    root.config ? `config: ${root.config}` : undefined,
    root.portBlock !== undefined ? `port block ${root.portBlock}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return (
    <div className="knowledge-bases__details" style={{ marginLeft: `${depth * 1.1 + 1.35}rem` }}>
      {details.length > 0 && <small>{details.join(' · ')}</small>}
    </div>
  );
}

function FolderIcon() {
  return <svg viewBox="0 0 20 16" aria-hidden="true"><path d="M1 3.5A2.5 2.5 0 0 1 3.5 1H8l2 2h6.5A2.5 2.5 0 0 1 19 5.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 1 12.5v-9Z" /></svg>;
}
