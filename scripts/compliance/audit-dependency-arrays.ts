#!/usr/bin/env ts-node
/**
 * Audit dependency arrays for compliance with ARCHITECTURE-TENETS.md
 *
 * Uses TypeScript Compiler API for precise AST analysis
 */

import * as ts from 'typescript';
import * as fs from 'fs';

interface HookAnalysis {
  filePath: string;
  hookName: string;
  usesEventBus: boolean;
  eventBusInDeps: boolean;
  usesClient: boolean;
  clientInDeps: boolean;
  acceptsCallbacks: boolean;
  callbacksInDeps: boolean;
  usesUseEventSubscriptions: boolean;
  hasInlineHandlers: boolean;
  dependencyCount: number;
  dependencies: string[];
  allDepsStable: boolean | null;
  issues: string[];

  // Container-specific
  isContainer: boolean;
  acceptsEventBusProp: boolean;
  hasEventContractDocs: boolean;
  emittedEvents: string[];
  subscribedEvents: string[];
  documentedEmittedEvents: string[];
  documentedSubscribedEvents: string[];

  // Hook return values
  returnsEventBus: boolean;

  // Event naming
  usesColonSeparatedEvents: boolean;
  usesHyphenSeparatedEvents: boolean;
  legacyEventNames: string[];

  // Layer separation (mitt-specific)
  usesEventBusOn: boolean;        // Direct eventBus.on() calls (should use useEventSubscriptions)
  usesEventBusOff: boolean;       // Direct eventBus.off() calls (useEventSubscriptions handles cleanup)
  createsEventSource: boolean;    // new EventSource() in components (should use useResourceEvents)
  returnsJSX: boolean;            // Hooks returning JSX (should return data only)
  hasGlobalEventBusImport: boolean; // Direct eventBus import (should use useEventBus() hook)
}

interface FileAnalysis {
  filePath: string;
  hooks: HookAnalysis[];
}

class DependencyArrayAuditor {
  /**
   * Detect if file is a container component based on path pattern
   */
  private detectContainerPattern(filePath: string): boolean {
    return filePath.includes('/containers/') && filePath.endsWith('.tsx');
  }

  /**
   * Extract JSDoc event contracts (@emits and @subscribes tags)
   */
  private extractJSDocEventContracts(node: ts.Node): { emits: string[], subscribes: string[] } {
    const emits: string[] = [];
    const subscribes: string[] = [];

    const jsDocTags = ts.getJSDocTags(node);
    for (const tag of jsDocTags) {
      const tagName = tag.tagName.text;
      const comment = tag.comment;

      if (tagName === 'emits' && typeof comment === 'string') {
        // Extract event name (first word before description)
        const match = comment.match(/^(\S+)/);
        if (match) {
          emits.push(match[1]);
        }
      } else if (tagName === 'subscribes' && typeof comment === 'string') {
        const match = comment.match(/^(\S+)/);
        if (match) {
          subscribes.push(match[1]);
        }
      }
    }

    return { emits, subscribes };
  }

  /**
   * Check if component accepts eventBus prop
   */
  private parseEventBusProp(params: ts.NodeArray<ts.ParameterDeclaration>): boolean {
    for (const param of params) {
      if (param.type && ts.isTypeLiteralNode(param.type)) {
        for (const member of param.type.members) {
          if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
            if (member.name.text === 'eventBus') {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  /**
   * Detect if hook returns eventBus instance
   */
  private detectEventBusReturn(body: ts.Block): boolean {
    let returnsEventBus = false;

    const visit = (node: ts.Node) => {
      // Look for return statements
      if (ts.isReturnStatement(node) && node.expression) {
        // Check if returning eventBus directly: return eventBus
        if (ts.isIdentifier(node.expression) && node.expression.text === 'eventBus') {
          returnsEventBus = true;
          return;
        }

        // Check if returning eventBus in an object: return { eventBus, ... } or return { eventBus: eventBus }
        if (ts.isObjectLiteralExpression(node.expression)) {
          for (const prop of node.expression.properties) {
            if (ts.isShorthandPropertyAssignment(prop)) {
              // return { eventBus }
              if (prop.name.text === 'eventBus') {
                returnsEventBus = true;
                return;
              }
            } else if (ts.isPropertyAssignment(prop)) {
              // return { eventBus: eventBus } or { eb: eventBus }
              if (ts.isIdentifier(prop.name) && prop.name.text === 'eventBus') {
                returnsEventBus = true;
                return;
              }
              if (ts.isIdentifier(prop.initializer) && prop.initializer.text === 'eventBus') {
                returnsEventBus = true;
                return;
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(body);
    return returnsEventBus;
  }

  /**
   * Extract emitted events from eventBus.emit() calls
   */
  private extractEmittedEvents(body: ts.Block): string[] {
    const events: string[] = [];

    const visit = (node: ts.Node) => {
      // Look for eventBus.emit('event-name', ...) calls
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (ts.isPropertyAccessExpression(expr) &&
            expr.name.text === 'emit' &&
            ts.isIdentifier(expr.expression) &&
            expr.expression.text === 'eventBus') {
          // Extract first argument (event name)
          if (node.arguments.length > 0) {
            const eventNameArg = node.arguments[0];
            if (ts.isStringLiteral(eventNameArg)) {
              events.push(eventNameArg.text);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(body);
    return events;
  }

  /**
   * Extract subscribed events from eventBus.on() calls and useEventSubscriptions() calls
   */
  private extractSubscribedEvents(body: ts.Block): string[] {
    const events: string[] = [];

    const visit = (node: ts.Node) => {
      // Look for eventBus.on('event-name', ...) calls
      if (ts.isCallExpression(node)) {
        const expr = node.expression;

        // Pattern 1: eventBus.on('event-name', handler)
        if (ts.isPropertyAccessExpression(expr) &&
            expr.name.text === 'on' &&
            ts.isIdentifier(expr.expression) &&
            expr.expression.text === 'eventBus') {
          // Extract first argument (event name)
          if (node.arguments.length > 0) {
            const eventNameArg = node.arguments[0];
            if (ts.isStringLiteral(eventNameArg)) {
              events.push(eventNameArg.text);
            }
          }
        }

        // Pattern 2: useEventSubscriptions({ 'event-name': handler, ... })
        if (ts.isIdentifier(expr) && expr.text === 'useEventSubscriptions') {
          if (node.arguments.length > 0) {
            const subscriptionsArg = node.arguments[0];
            if (ts.isObjectLiteralExpression(subscriptionsArg)) {
              // Extract all string literal property names
              for (const prop of subscriptionsArg.properties) {
                if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.name)) {
                  events.push(prop.name.text);
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(body);
    return events;
  }

  /**
   * Analyze event naming convention (colon vs hyphen)
   */
  private analyzeEventNaming(eventName: string): { isColon: boolean, isHyphen: boolean } {
    // Correct pattern: namespace:event-name (colon for namespace, hyphen allowed in event name)
    // Legacy pattern: namespace-event-name (hyphen used for namespacing instead of colon)

    // Check if event uses colon for namespacing
    const hasColon = eventName.includes(':');

    // Only flag as legacy if hyphen is used for namespacing (no colon present)
    // Hyphens within the event name part (after colon) are perfectly fine
    const isLegacyHyphenNamespace = !hasColon && eventName.includes('-');

    return {
      isColon: hasColon,
      isHyphen: isLegacyHyphenNamespace
    };
  }

  /**
   * Detect eventBus.on() calls (components should use useEventSubscriptions)
   */
  private detectEventBusOn(body: ts.Block): boolean {
    let found = false;

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (ts.isPropertyAccessExpression(expr) &&
            expr.name.text === 'on' &&
            ts.isIdentifier(expr.expression) &&
            expr.expression.text === 'eventBus') {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(body);
    return found;
  }

  /**
   * Detect eventBus.off() calls (useEventSubscriptions handles cleanup)
   */
  private detectEventBusOff(body: ts.Block): boolean {
    let found = false;

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (ts.isPropertyAccessExpression(expr) &&
            expr.name.text === 'off' &&
            ts.isIdentifier(expr.expression) &&
            expr.expression.text === 'eventBus') {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(body);
    return found;
  }

  /**
   * Detect new EventSource() creation (components should use useResourceEvents)
   */
  private detectEventSourceCreation(body: ts.Block): boolean {
    let found = false;

    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node)) {
        const expr = node.expression;
        if (ts.isIdentifier(expr) && expr.text === 'EventSource') {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(body);
    return found;
  }

  /**
   * Detect JSX return statements in hooks (hooks should return data, not JSX)
   */
  private detectJSXReturn(body: ts.Block): boolean {
    let found = false;

    const visit = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && node.expression) {
        // Check if returning JSX element
        if (ts.isJsxElement(node.expression) ||
            ts.isJsxSelfClosingElement(node.expression) ||
            ts.isJsxFragment(node.expression)) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(body);
    return found;
  }

  /**
   * Detect global eventBus imports (should use useEventBus() hook)
   */
  private detectGlobalEventBusImport(sourceFile: ts.SourceFile): boolean {
    let found = false;

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const importClause = node.importClause;
        if (importClause && importClause.namedBindings) {
          if (ts.isNamedImports(importClause.namedBindings)) {
            for (const element of importClause.namedBindings.elements) {
              if (element.name.text === 'eventBus') {
                found = true;
                return;
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return found;
  }

  analyzeFile(filePath: string): FileAnalysis {
    const sourceFile = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, 'utf-8'),
      ts.ScriptTarget.Latest,
      true
    );

    const hooks: HookAnalysis[] = [];

    // Check for global eventBus import at file level
    const hasGlobalEventBusImport = this.detectGlobalEventBusImport(sourceFile);

    const visit = (node: ts.Node) => {
      // Look for function declarations/expressions that might be hooks
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        const analysis = this.analyzeHook(node, filePath, hasGlobalEventBusImport);
        if (analysis) {
          hooks.push(analysis);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return { filePath, hooks };
  }

  private analyzeHook(node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction, filePath: string, hasGlobalEventBusImport: boolean): HookAnalysis | null {
    // Get function name - handle variable declarations like "const useMyHook = () => {}"
    let hookName = 'anonymous';
    if (ts.isFunctionDeclaration(node) && node.name) {
      hookName = node.name.text;
    } else if (ts.isFunctionExpression(node) && node.name) {
      hookName = node.name.text;
    } else if (ts.isArrowFunction(node)) {
      // Check if this arrow function is assigned to a variable
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        hookName = parent.name.text;
      } else if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
        hookName = parent.name.text;
      }
    }

    // Only analyze hooks (start with 'use') or components (start with capital)
    if (!hookName.startsWith('use') && !/^[A-Z]/.test(hookName)) {
      return null;
    }

    const analysis: HookAnalysis = {
      filePath,
      hookName,
      usesEventBus: false,
      eventBusInDeps: false,
      usesClient: false,
      clientInDeps: false,
      acceptsCallbacks: false,
      callbacksInDeps: false,
      usesUseEventSubscriptions: false,
      hasInlineHandlers: false,
      dependencyCount: 0,
      dependencies: [],
      allDepsStable: null,
      issues: [],

      // Container-specific
      isContainer: this.detectContainerPattern(filePath),
      acceptsEventBusProp: false,
      hasEventContractDocs: false,
      emittedEvents: [],
      subscribedEvents: [],
      documentedEmittedEvents: [],
      documentedSubscribedEvents: [],

      // Hook return values
      returnsEventBus: false,

      // Event naming
      usesColonSeparatedEvents: false,
      usesHyphenSeparatedEvents: false,
      legacyEventNames: [],

      // Layer separation (mitt-specific)
      usesEventBusOn: false,
      usesEventBusOff: false,
      createsEventSource: false,
      returnsJSX: false,
      hasGlobalEventBusImport: false
    };

    // Extract JSDoc event contracts
    const eventContracts = this.extractJSDocEventContracts(node);
    analysis.documentedEmittedEvents = eventContracts.emits;
    analysis.documentedSubscribedEvents = eventContracts.subscribes;
    analysis.hasEventContractDocs = eventContracts.emits.length > 0 || eventContracts.subscribes.length > 0;

    // Check for eventBus prop
    if (node.parameters) {
      analysis.acceptsEventBusProp = this.parseEventBusProp(node.parameters);
      if (analysis.acceptsEventBusProp) {
        analysis.issues.push('❌ Component accepts eventBus prop (use useEventBus() hook instead)');
      }
    }

    // Set global eventBus import flag
    analysis.hasGlobalEventBusImport = hasGlobalEventBusImport;

    // Analyze function body
    if (node.body && ts.isBlock(node.body)) {
      this.analyzeFunctionBody(node.body, analysis);

      // Extract emitted and subscribed events
      analysis.emittedEvents = this.extractEmittedEvents(node.body);
      analysis.subscribedEvents = this.extractSubscribedEvents(node.body);

      // Analyze event naming
      const allEvents = [...analysis.emittedEvents, ...analysis.subscribedEvents];
      for (const eventName of allEvents) {
        const naming = this.analyzeEventNaming(eventName);
        if (naming.isColon) {
          analysis.usesColonSeparatedEvents = true;
        }
        if (naming.isHyphen) {
          analysis.usesHyphenSeparatedEvents = true;
          analysis.legacyEventNames.push(eventName);
        }
      }

      // Check if hook returns eventBus
      analysis.returnsEventBus = this.detectEventBusReturn(node.body);
      if (analysis.returnsEventBus) {
        analysis.issues.push('❌ Hook returns eventBus instance (should not expose EventBus)');
      }

      // Layer separation checks
      analysis.usesEventBusOn = this.detectEventBusOn(node.body);
      analysis.usesEventBusOff = this.detectEventBusOff(node.body);
      analysis.createsEventSource = this.detectEventSourceCreation(node.body);
      analysis.returnsJSX = this.detectJSXReturn(node.body);

      // Determine if this is a component (not a hook)
      const isComponent = /^[A-Z]/.test(analysis.hookName) && !analysis.hookName.startsWith('use');
      const isHook = analysis.hookName.startsWith('use');

      // Layer separation violations
      if (isComponent && analysis.usesEventBusOn) {
        analysis.issues.push('❌ Component uses eventBus.on() (use useEventSubscriptions hook instead)');
      }
      if (isComponent && analysis.usesEventBusOff) {
        analysis.issues.push('❌ Component uses eventBus.off() (useEventSubscriptions handles cleanup automatically)');
      }
      if (isComponent && analysis.createsEventSource) {
        analysis.issues.push('❌ Component creates EventSource directly (use useResourceEvents hook instead)');
      }
      if (isHook && analysis.returnsJSX) {
        analysis.issues.push('❌ Hook returns JSX (hooks should return data/state, not JSX)');
      }
      if (hasGlobalEventBusImport && !filePath.includes('EventBusContext')) {
        analysis.issues.push('❌ File imports global eventBus (use useEventBus() hook instead)');
      }
    }

    // Analyze parameters for callbacks
    if (node.parameters) {
      this.analyzeParameters(node.parameters, analysis);
    }

    // Container-specific validation
    if (analysis.isContainer) {
      if (analysis.acceptsCallbacks) {
        analysis.issues.push('❌ Container accepts callback props (containers must use events only)');
      }
      // Containers must use useEventBus() OR useEventSubscriptions() (which internally uses useEventBus())
      // Subscribe-only containers (no emits) can use useEventSubscriptions() without direct useEventBus()
      const hasEmittedEvents = analysis.emittedEvents.length > 0;
      if (!analysis.usesEventBus && !analysis.usesUseEventSubscriptions) {
        analysis.issues.push('❌ Container does not use useEventBus() hook');
      } else if (!analysis.usesEventBus && hasEmittedEvents) {
        // Only require direct useEventBus() if container emits events
        analysis.issues.push('❌ Container emits events but does not use useEventBus() hook directly');
      }
      const missingEmitsDocs = analysis.emittedEvents.filter(e => !analysis.documentedEmittedEvents.includes(e));
      const missingSubscribesDocs = analysis.subscribedEvents.filter(e => !analysis.documentedSubscribedEvents.includes(e));
      if (missingEmitsDocs.length > 0) {
        analysis.issues.push(`❌ Container missing @emits JSDoc for: ${missingEmitsDocs.join(', ')}`);
      }
      if (missingSubscribesDocs.length > 0) {
        analysis.issues.push(`❌ Container missing @subscribes JSDoc for: ${missingSubscribesDocs.join(', ')}`);
      }
    }

    return analysis;
  }

  private analyzeFunctionBody(body: ts.Block, analysis: HookAnalysis) {
    const allDeps: Set<string> = new Set();
    let hasAnyDeps = false;
    const callbacksStoredInRefs = new Set<string>();
    const localCallbacks = new Set<string>();

    const visit = (node: ts.Node) => {
      // Track locally-defined callbacks (useCallback, useMemo, or function declarations)
      if (ts.isVariableStatement(node)) {
        const declarations = node.declarationList.declarations;
        for (const decl of declarations) {
          if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
            const varName = decl.name.text;
            if (decl.initializer) {
              // Track useRef callbacks
              if (ts.isCallExpression(decl.initializer) &&
                  ts.isIdentifier(decl.initializer.expression) &&
                  decl.initializer.expression.text === 'useRef') {
                const arg = decl.initializer.arguments[0];
                if (arg && ts.isIdentifier(arg) && /^(on[A-Z]|handle[A-Z])/.test(arg.text)) {
                  callbacksStoredInRefs.add(arg.text);
                }
              }
              // Track useCallback/useMemo as local callbacks
              if (ts.isCallExpression(decl.initializer) &&
                  ts.isIdentifier(decl.initializer.expression) &&
                  ['useCallback', 'useMemo'].includes(decl.initializer.expression.text)) {
                localCallbacks.add(varName);
              }
            }
          }
        }
      }

      // Look for xxxRef.current = xxx; pattern
      if (ts.isExpressionStatement(node)) {
        const expr = node.expression;
        if (ts.isBinaryExpression(expr) &&
            expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const left = expr.left;
          const right = expr.right;
          if (ts.isPropertyAccessExpression(left) &&
              left.name.text === 'current' &&
              ts.isIdentifier(right) &&
              /^(on[A-Z]|handle[A-Z])/.test(right.text)) {
            callbacksStoredInRefs.add(right.text);
          }
        }
      }

      // Look for useEffect, useCallback, useMemo calls
      if (ts.isCallExpression(node)) {
        const expr = node.expression;

        if (ts.isIdentifier(expr)) {
          const hookName = expr.text;

          // Check for useEventBus
          if (hookName === 'useEventBus') {
            analysis.usesEventBus = true;
          }

          // Check for useApiClient
          if (hookName === 'useApiClient') {
            analysis.usesClient = true;
          }

          // Check for useEventSubscriptions
          if (hookName === 'useEventSubscriptions') {
            analysis.usesUseEventSubscriptions = true;
            // Check if handlers are inline
            if (node.arguments.length > 0) {
              const arg = node.arguments[0];
              if (ts.isObjectLiteralExpression(arg)) {
                analysis.hasInlineHandlers = this.hasInlineArrowFunctions(arg);
              }
            }
          }

          // Analyze useEffect/useCallback/useMemo dependency arrays
          if (['useEffect', 'useCallback', 'useMemo', 'useEventOperations'].includes(hookName)) {
            const deps = this.extractDependencyArray(node);
            if (deps) {
              hasAnyDeps = true;
              deps.forEach(d => allDeps.add(d));

              // Check for violations
              if (deps.includes('eventBus')) {
                analysis.eventBusInDeps = true;
                analysis.issues.push('❌ eventBus in dependency array (global singleton)');
              }

              if (deps.includes('client')) {
                analysis.clientInDeps = true;
              }

              // Check for callback-like dependencies (functions starting with 'on')
              // Exclude local callbacks (defined via useCallback/useMemo) and callbacks stored in refs
              const callbacks = deps.filter(d => /^on[A-Z]/.test(d));
              const unsafeCallbacks = callbacks.filter(cb =>
                !callbacksStoredInRefs.has(cb) && !localCallbacks.has(cb)
              );
              if (unsafeCallbacks.length > 0) {
                analysis.callbacksInDeps = true;
                analysis.issues.push(`❌ Callback props in deps: ${unsafeCallbacks.join(', ')} (use events or refs instead)`);
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(body);

    // Aggregate all dependencies found
    if (hasAnyDeps) {
      analysis.dependencies = Array.from(allDeps);
      analysis.dependencyCount = analysis.dependencies.length;
    }
  }

  private analyzeParameters(parameters: ts.NodeArray<ts.ParameterDeclaration>, analysis: HookAnalysis) {
    parameters.forEach(param => {
      if (param.type && ts.isTypeLiteralNode(param.type)) {
        param.type.members.forEach(member => {
          if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
            const propName = member.name.text;
            // Check for callback props (start with 'on')
            if (propName.startsWith('on') && member.type && this.isFunctionType(member.type)) {
              analysis.acceptsCallbacks = true;
            }
          }
        });
      }
    });
  }

  private extractDependencyArray(callExpr: ts.CallExpression): string[] | null {
    // Dependency array is typically the last argument
    const lastArg = callExpr.arguments[callExpr.arguments.length - 1];

    if (!lastArg || !ts.isArrayLiteralExpression(lastArg)) {
      return null;
    }

    return lastArg.elements.map(elem => {
      if (ts.isIdentifier(elem)) {
        return elem.text;
      }
      if (ts.isPropertyAccessExpression(elem)) {
        return elem.getText();
      }
      return elem.getText();
    });
  }

  private hasInlineArrowFunctions(obj: ts.ObjectLiteralExpression): boolean {
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop)) {
        if (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer)) {
          return true;
        }
      }
    }
    return false;
  }

  private isFunctionType(node: ts.TypeNode): boolean {
    return ts.isFunctionTypeNode(node);
  }
}

// Main execution
function main() {
  const auditor = new DependencyArrayAuditor();

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: ts-node audit-dependency-arrays.ts <file-path>');
    process.exit(1);
  }

  const filePath = args[0];

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const result = auditor.analyzeFile(filePath);

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

export { DependencyArrayAuditor };
export type { HookAnalysis, FileAnalysis };
