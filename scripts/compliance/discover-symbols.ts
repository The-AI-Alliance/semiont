#!/usr/bin/env tsx

/**
 * Symbol Discovery Engine
 *
 * Crawls TypeScript source files using AST to discover all exported symbols.
 * Categorizes symbols as hooks, components, functions, or interfaces.
 * Outputs JSON for downstream compliance analysis.
 *
 * Usage:
 *   npx tsx discover-symbols.ts <src-dir> <output-json>
 *
 * Example:
 *   npx tsx discover-symbols.ts ../src ./symbols.json
 */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

interface DiscoveredSymbol {
  name: string;
  type: 'hook' | 'component' | 'function' | 'interface' | 'type';
  file: string;
  lineNumber: number;
  exported: boolean;
}

class SymbolDiscoverer {
  private symbols: DiscoveredSymbol[] = [];

  async discoverInDirectory(srcDir: string): Promise<DiscoveredSymbol[]> {
    const files = await glob('**/*.{ts,tsx}', {
      cwd: srcDir,
      ignore: [
        '**/*.test.{ts,tsx}',
        '**/__tests__/**',
        '**/*.spec.{ts,tsx}',
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**'
      ],
      absolute: false
    });

    console.error(`Found ${files.length} source files to analyze`);

    for (const file of files) {
      const fullPath = path.join(srcDir, file);
      this.analyzeFile(fullPath, file);
    }

    return this.symbols;
  }

  private analyzeFile(fullPath: string, relativePath: string): void {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      fullPath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    // Find named exports: export { foo, bar }
    const namedExports = this.findNamedExports(sourceFile);

    const visit = (node: ts.Node) => {
      // Function declarations: export function foo() {}
      if (ts.isFunctionDeclaration(node) && node.name) {
        const isExported = this.hasExportModifier(node) || namedExports.has(node.name.text);
        if (isExported) {
          this.addSymbol(relativePath, node.name.text, node, 'function');
        }
      }

      // Variable statements: export const foo = () => {}
      if (ts.isVariableStatement(node)) {
        const isExported = this.hasExportModifier(node);

        node.declarationList.declarations.forEach(decl => {
          if (ts.isIdentifier(decl.name)) {
            const name = decl.name.text;
            const isNamedExport = namedExports.has(name);

            if (isExported || isNamedExport) {
              // Determine if it's a function (arrow function or function expression)
              const isFunction = decl.initializer && (
                ts.isArrowFunction(decl.initializer) ||
                ts.isFunctionExpression(decl.initializer)
              );

              if (isFunction) {
                this.addSymbol(relativePath, name, decl, 'function');
              }
            }
          }
        });
      }

      // Class declarations: export class Foo {}
      if (ts.isClassDeclaration(node) && node.name) {
        const isExported = this.hasExportModifier(node) || namedExports.has(node.name.text);
        if (isExported) {
          this.addSymbol(relativePath, node.name.text, node, 'component');
        }
      }

      // Type aliases: export type Foo = ...
      if (ts.isTypeAliasDeclaration(node)) {
        const isExported = this.hasExportModifier(node) || namedExports.has(node.name.text);
        if (isExported) {
          this.addSymbol(relativePath, node.name.text, node, 'type');
        }
      }

      // Interfaces: export interface Foo {}
      if (ts.isInterfaceDeclaration(node)) {
        const isExported = this.hasExportModifier(node) || namedExports.has(node.name.text);
        if (isExported) {
          this.addSymbol(relativePath, node.name.text, node, 'interface');
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  private hasExportModifier(node: ts.Node): boolean {
    if (!('modifiers' in node)) return false;
    const modifiers = (node as any).modifiers as ts.NodeArray<ts.Modifier> | undefined;
    if (!modifiers) return false;
    return modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  }

  private findNamedExports(sourceFile: ts.SourceFile): Set<string> {
    const exported = new Set<string>();

    const visit = (node: ts.Node) => {
      // Named exports: export { foo, bar }
      if (ts.isExportDeclaration(node) && node.exportClause) {
        if (ts.isNamedExports(node.exportClause)) {
          node.exportClause.elements.forEach(e => {
            exported.add(e.name.text);
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return exported;
  }

  private addSymbol(
    file: string,
    name: string,
    node: ts.Node,
    declaredType: 'function' | 'component' | 'interface' | 'type'
  ): void {
    const sourceFile = node.getSourceFile();
    const lineNumber = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

    // Categorize based on naming convention
    let type: DiscoveredSymbol['type'] = declaredType;

    if (declaredType === 'function') {
      if (name.startsWith('use')) {
        type = 'hook';
      } else if (name[0] === name[0].toUpperCase()) {
        type = 'component';
      } else {
        type = 'function';
      }
    } else if (declaredType === 'component') {
      // Classes are always components
      type = 'component';
    } else {
      type = declaredType;
    }

    this.symbols.push({
      name,
      type,
      file,
      lineNumber,
      exported: true
    });
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: discover-symbols.ts <src-dir> <output-json>');
    console.error('Example: discover-symbols.ts ../src ./symbols.json');
    process.exit(1);
  }

  const [srcDir, outputPath] = args;

  if (!fs.existsSync(srcDir)) {
    console.error(`Error: Source directory not found: ${srcDir}`);
    process.exit(1);
  }

  console.error(`Discovering symbols in: ${srcDir}`);

  const discoverer = new SymbolDiscoverer();
  const symbols = await discoverer.discoverInDirectory(srcDir);

  // Group by type for summary
  const byType = symbols.reduce((acc, s) => {
    acc[s.type] = (acc[s.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.error(`\nDiscovered ${symbols.length} symbols:`);
  Object.entries(byType).forEach(([type, count]) => {
    console.error(`  ${type}: ${count}`);
  });

  // Write JSON output
  fs.writeFileSync(outputPath, JSON.stringify(symbols, null, 2));
  console.error(`\nWrote symbols to: ${outputPath}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
