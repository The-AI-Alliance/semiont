/**
 * Terminal UI Application
 *
 * Interactive terminal interface for managing dataset operations
 */

import blessed from 'blessed';
import { existsSync, readFileSync } from 'node:fs';
import type { DatasetConfigWithPaths } from '../config/types.js';
import { downloadCommand, loadCommand, annotateCommand, validateCommand } from '../demo.js';

interface CommandStatus {
  dataset: string;
  command: 'download' | 'load' | 'annotate' | 'validate';
  hasRun: boolean;
}

interface SelectedItem {
  type: 'dataset' | 'command';
  dataset: string;
  command?: 'download' | 'load' | 'annotate' | 'validate';
}

export class TerminalApp {
  private screen: blessed.Widgets.Screen;
  private datasetList: blessed.Widgets.ListElement;
  private detailsBox: blessed.Widgets.BoxElement;
  private activityLog: blessed.Widgets.BoxElement;
  private activityContent: string[] = [];
  private datasets: Record<string, DatasetConfigWithPaths>;
  private listItems: SelectedItem[] = [];
  private commandStatuses: CommandStatus[] = [];
  private isRunningCommand: boolean = false;

  constructor(datasets: Record<string, DatasetConfigWithPaths>) {
    this.datasets = datasets;

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Semiont Demo - Interactive Mode',
    });

    // Create dataset list (top left)
    this.datasetList = blessed.list({
      top: 0,
      left: 0,
      width: '33%',
      height: '50%',
      label: ' Datasets & Commands ',
      border: { type: 'line' },
      style: {
        selected: { bg: 'blue', fg: 'white' },
        item: { fg: 'white' },
        border: { fg: 'cyan' },
      },
      keys: true,
      vi: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '█',
        style: { fg: 'cyan' },
      },
      tags: true,
    });

    // Create details box (bottom left)
    this.detailsBox = blessed.box({
      top: '50%',
      left: 0,
      width: '33%',
      height: '50%',
      label: ' Details ',
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '█',
        style: { fg: 'cyan' },
      },
      tags: true,
      input: true,
      keyable: true,
    });

    // Create activity log (right side)
    this.activityLog = blessed.box({
      top: 0,
      left: '33%',
      width: '67%',
      height: '100%',
      label: ' Activity Log ',
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '█',
        style: { fg: 'cyan' },
      },
      tags: true,
      input: true,
      keyable: true,
    });

    // Add widgets to screen
    this.screen.append(this.datasetList);
    this.screen.append(this.detailsBox);
    this.screen.append(this.activityLog);

    // Build list items and check statuses
    this.buildListItems();
    this.checkCommandStatuses();
    this.populateList();

    // Set up event handlers
    this.setupEventHandlers();

    // Show initial details
    this.updateDetails();

    // Set initial focus
    this.datasetList.focus();

    // Render screen
    this.screen.render();
  }

  private buildListItems() {
    const items: SelectedItem[] = [];

    for (const [name, config] of Object.entries(this.datasets)) {
      // Add dataset header
      items.push({ type: 'dataset', dataset: name });

      // Add commands
      if (config.downloadContent) {
        items.push({ type: 'command', dataset: name, command: 'download' });
      }
      items.push({ type: 'command', dataset: name, command: 'load' });
      if (config.detectCitations) {
        items.push({ type: 'command', dataset: name, command: 'annotate' });
      }
      items.push({ type: 'command', dataset: name, command: 'validate' });
    }

    this.listItems = items;
  }

  private checkCommandStatuses() {
    const statuses: CommandStatus[] = [];

    for (const [name, config] of Object.entries(this.datasets)) {
      // Check download status
      if (config.downloadContent && config.cacheFile) {
        const hasRun = existsSync(config.cacheFile);
        statuses.push({ dataset: name, command: 'download', hasRun });
      }

      // Check load status (has state file)
      const loadHasRun = existsSync(config.stateFile);
      statuses.push({ dataset: name, command: 'load', hasRun: loadHasRun });

      // Check annotate status (state file exists and has annotation data)
      if (config.detectCitations) {
        let annotateHasRun = false;
        if (existsSync(config.stateFile)) {
          try {
            const state = JSON.parse(readFileSync(config.stateFile, 'utf-8'));
            annotateHasRun = !!state.annotations;
          } catch {
            annotateHasRun = false;
          }
        }
        statuses.push({ dataset: name, command: 'annotate', hasRun: annotateHasRun });
      }

      // Validate is always available but never marked as "run" (it's a diagnostic command)
      statuses.push({ dataset: name, command: 'validate', hasRun: false });
    }

    this.commandStatuses = statuses;
  }

  private getCommandStatus(dataset: string, command: string): boolean {
    return this.commandStatuses.find(
      (s) => s.dataset === dataset && s.command === command
    )?.hasRun || false;
  }

  private populateList() {
    // Save current selection
    const currentIndex = this.getSelectedIndex();

    const items = this.listItems.map((item) => {
      if (item.type === 'dataset') {
        const config = this.datasets[item.dataset];
        return `{bold}${config.displayName}{/bold}`;
      } else {
        const hasRun = this.getCommandStatus(item.dataset, item.command!);
        const indicator = hasRun ? '{green-fg}✓{/green-fg}' : '{gray-fg}○{/gray-fg}';
        return `    ${indicator} ${item.command}`;
      }
    });

    this.datasetList.setItems(items);

    // Restore selection
    this.datasetList.select(currentIndex);
    this.screen.render();
  }

  private setupEventHandlers() {
    // Quit on Escape, q, or Control-C
    this.screen.key(['escape', 'q', 'C-c'], () => {
      return process.exit(0);
    });

    // Update details when selection changes (by any means - arrow keys, j/k, mouse, etc.)
    this.datasetList.on('select item', () => {
      this.updateDetails();
    });

    // Execute command on Enter
    this.datasetList.key(['enter'], () => {
      this.executeSelected();
    });

    // Tab to cycle focus through panels
    this.screen.key(['tab'], () => {
      const focused = this.screen.focused;
      if (focused === this.datasetList) {
        this.detailsBox.focus();
      } else if (focused === this.detailsBox) {
        this.activityLog.focus();
      } else {
        this.datasetList.focus();
      }
      this.screen.render();
    });

    // Scrolling with j/k (vim style) - check which panel is focused
    this.screen.key(['k', 'up'], () => {
      const focused = this.screen.focused;
      if (focused === this.detailsBox) {
        this.detailsBox.scroll(-1);
        this.screen.render();
      } else if (focused === this.activityLog) {
        this.activityLog.scroll(-1);
        this.screen.render();
      }
    });

    this.screen.key(['j', 'down'], () => {
      const focused = this.screen.focused;
      if (focused === this.detailsBox) {
        this.detailsBox.scroll(1);
        this.screen.render();
      } else if (focused === this.activityLog) {
        this.activityLog.scroll(1);
        this.screen.render();
      }
    });

    // Show help on 'h'
    this.screen.key(['h'], () => {
      this.showHelp();
    });
  }

  private getSelectedIndex(): number {
    // Get the currently selected index from the list
    return (this.datasetList as any).selected || 0;
  }

  private updateDetails() {
    const selectedIndex = this.getSelectedIndex();
    const selected = this.listItems[selectedIndex];
    if (!selected) return;

    const config = this.datasets[selected.dataset];
    let content = '';

    if (selected.type === 'dataset') {
      // Show dataset configuration
      content += `{bold}{cyan-fg}Dataset: ${config.displayName}{/cyan-fg}{/bold}\n\n`;
      content += `{bold}Name:{/bold} ${config.name}\n`;
      content += `{bold}Emoji:{/bold} ${config.emoji}\n`;
      content += `{bold}Chunk:{/bold} ${config.shouldChunk ? `Yes (${config.chunkSize} chars${config.useSmartChunking ? ', smart' : ''})` : 'No'}\n`;
      content += `{bold}Multi-Document:{/bold} ${config.isMultiDocument ? 'Yes' : 'No'}\n`;
      content += `{bold}Table of Contents:{/bold} ${config.createTableOfContents ? 'Yes' : 'No'}\n`;
      content += `{bold}Detect Citations:{/bold} ${config.detectCitations ? 'Yes' : 'No'}\n`;
      content += `{bold}Entity Types:{/bold} ${config.entityTypes.join(', ')}\n`;
      content += `{bold}Cache File:{/bold} ${config.cacheFile}\n`;
      content += `{bold}State File:{/bold} ${config.stateFile}\n\n`;

      // Show state if exists
      if (existsSync(config.stateFile)) {
        try {
          const state = JSON.parse(readFileSync(config.stateFile, 'utf-8'));
          content += `{bold}{green-fg}State:{/green-fg}{/bold}\n`;
          content += JSON.stringify(state, null, 2)
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n');
        } catch (error) {
          content += `{bold}{red-fg}Error reading state:{/red-fg}{/bold} ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        content += `{bold}{yellow-fg}No state file yet{/yellow-fg}{/bold}`;
      }
    } else {
      // Show command details
      const hasRun = this.getCommandStatus(selected.dataset, selected.command!);
      content += `{bold}{cyan-fg}Command: ${selected.command}{/cyan-fg}{/bold}\n`;
      content += `{bold}Dataset:{/bold} ${config.displayName}\n`;
      content += `{bold}Status:{/bold} ${hasRun ? '{green-fg}✓ Completed{/green-fg}' : '{yellow-fg}○ Not run{/yellow-fg}'}\n\n`;

      content += `{bold}Description:{/bold}\n`;
      if (selected.command === 'download') {
        content += `  Downloads content from remote source and caches locally.\n`;
        content += `  {bold}Cache:{/bold} ${config.cacheFile}\n`;
      } else if (selected.command === 'load') {
        content += `  Loads content, processes it, and uploads to backend.\n`;
        if (config.shouldChunk) {
          content += `  {bold}Chunking:{/bold} ${config.chunkSize} chars${config.useSmartChunking ? ' (smart)' : ''}\n`;
        }
        if (config.createTableOfContents) {
          content += `  {bold}TOC:{/bold} Creates table of contents\n`;
        }
      } else if (selected.command === 'annotate') {
        content += `  Detects patterns and creates annotations.\n`;
        if (config.detectCitations) {
          content += `  {bold}Citations:{/bold} Detects legal citations\n`;
        }
      } else if (selected.command === 'validate') {
        content += `  Fetches all resources and validates their content.\n`;
        content += `  {bold}Checks:{/bold} TOC, chunks, documents\n`;
        content += `  {bold}Cache:{/bold} /tmp/semiont_*\n`;
        content += `  Shows URI, media type, checksum, and text preview.\n`;
      }

      // Show state excerpt if exists
      if (existsSync(config.stateFile)) {
        try {
          const state = JSON.parse(readFileSync(config.stateFile, 'utf-8'));
          content += `\n{bold}{green-fg}State:{/green-fg}{/bold}\n`;

          if (selected.command === 'download' && state.cacheFile) {
            content += `  Cache: ${state.cacheFile}\n`;
          } else if (selected.command === 'load') {
            if (state.chunkIds) {
              content += `  Chunks: ${state.chunkIds.length}\n`;
            }
            if (state.documentIds) {
              content += `  Documents: ${state.documentIds.length}\n`;
            }
            if (state.tocId) {
              content += `  TOC: ${state.tocId}\n`;
            }
          } else if (selected.command === 'annotate' && state.annotations) {
            content += `  Annotations: ${state.annotations.length}\n`;
          } else if (selected.command === 'validate') {
            let resourceCount = 0;
            if (state.tocId) resourceCount++;
            if (state.chunkIds) resourceCount += state.chunkIds.length;
            if (state.documentIds) resourceCount += state.documentIds.length;
            content += `  Resources to validate: ${resourceCount}\n`;
          }
        } catch {
          // Ignore errors
        }
      }
    }

    this.detailsBox.setContent(content);
    this.screen.render();
  }

  private logToActivity(message: string) {
    this.activityContent.push(message);
    // Keep last 1000 lines
    if (this.activityContent.length > 1000) {
      this.activityContent = this.activityContent.slice(-1000);
    }
    this.activityLog.setContent(this.activityContent.join('\n'));
    this.activityLog.setScrollPerc(100);
    this.screen.render();
  }

  private async executeSelected() {
    const selectedIndex = this.getSelectedIndex();
    const selected = this.listItems[selectedIndex];
    if (!selected || selected.type === 'dataset') {
      return; // Can't execute dataset itself
    }

    if (this.isRunningCommand) {
      this.logToActivity('{red-fg}Another command is already running!{/red-fg}');
      return;
    }

    const config = this.datasets[selected.dataset];
    const command = selected.command!;

    this.logToActivity('\n{bold}{cyan-fg}═══════════════════════════════════════{/cyan-fg}{/bold}');
    this.logToActivity(`{bold}{green-fg}Executing: ${config.displayName} - ${command}{/green-fg}{/bold}`);
    this.logToActivity('{bold}{cyan-fg}═══════════════════════════════════════{/cyan-fg}{/bold}\n');

    this.isRunningCommand = true;

    // Intercept console.log to capture output (suppress original to avoid corrupting blessed UI)
    const originalLog = console.log;
    const originalError = console.error;

    console.log = (...args: any[]) => {
      this.logToActivity(args.join(' '));
    };

    console.error = (...args: any[]) => {
      this.logToActivity(`{red-fg}${args.join(' ')}{/red-fg}`);
    };

    try {
      // Call the appropriate command function
      if (command === 'download') {
        await downloadCommand(selected.dataset);
      } else if (command === 'load') {
        await loadCommand(selected.dataset);
      } else if (command === 'annotate') {
        await annotateCommand(selected.dataset);
      } else if (command === 'validate') {
        await validateCommand(selected.dataset);
      }

      this.logToActivity('\n{bold}{green-fg}✓ Command completed successfully{/green-fg}{/bold}\n');
    } catch (error) {
      this.logToActivity(`\n{bold}{red-fg}✗ Command failed: ${(error as Error).message}{/red-fg}{/bold}\n`);
    } finally {
      // Restore console
      console.log = originalLog;
      console.error = originalError;

      this.isRunningCommand = false;

      // Refresh statuses
      this.checkCommandStatuses();
      this.populateList();
      this.updateDetails();
    }
  }

  private showHelp() {
    this.activityContent = []; // Clear activity log
    this.logToActivity('{bold}{cyan-fg}═══════════════════════════════════════{/cyan-fg}{/bold}');
    this.logToActivity('{bold}{cyan-fg}           HELP - Keyboard Controls{/cyan-fg}{/bold}');
    this.logToActivity('{bold}{cyan-fg}═══════════════════════════════════════{/cyan-fg}{/bold}\n');

    this.logToActivity('{bold}{yellow-fg}Navigation:{/yellow-fg}{/bold}');
    this.logToActivity('  {bold}↑/↓{/bold} or {bold}j/k{/bold}       - Navigate lists and scroll panels');
    this.logToActivity('  {bold}Tab{/bold}               - Switch focus between panels');
    this.logToActivity('  {bold}Enter{/bold}             - Execute selected command\n');

    this.logToActivity('{bold}{yellow-fg}Actions:{/yellow-fg}{/bold}');
    this.logToActivity('  {bold}h{/bold}                 - Show this help');
    this.logToActivity('  {bold}q{/bold} or {bold}Esc{/bold}         - Quit application');
    this.logToActivity('  {bold}Ctrl-C{/bold}            - Force quit\n');

    this.logToActivity('{bold}{yellow-fg}Panels:{/yellow-fg}{/bold}');
    this.logToActivity('  {bold}Top Left{/bold}          - Datasets & Commands list');
    this.logToActivity('                      • Select dataset to view config');
    this.logToActivity('                      • Select command to view details');
    this.logToActivity('                      • Press Enter to execute command');
    this.logToActivity('  {bold}Bottom Left{/bold}       - Details panel');
    this.logToActivity('                      • Shows config/state for selection');
    this.logToActivity('  {bold}Right Half{/bold}        - Activity Log (this panel)');
    this.logToActivity('                      • Real-time command output\n');

    this.logToActivity('{bold}{yellow-fg}Status Indicators:{/yellow-fg}{/bold}');
    this.logToActivity('  {green-fg}✓{/green-fg}                 - Command has been run');
    this.logToActivity('  {gray-fg}○{/gray-fg}                 - Command not yet run\n');

    this.logToActivity('{bold}{yellow-fg}Text Selection:{/yellow-fg}{/bold}');
    this.logToActivity('  Hold {bold}Shift{/bold} (or {bold}Option/Alt{/bold} on Mac) while selecting');
    this.logToActivity('  with your mouse to copy text from the terminal\n');

    this.logToActivity('{bold}{yellow-fg}Command Workflow:{/yellow-fg}{/bold}');
    this.logToActivity('  1. {bold}download{/bold}  - Fetch content from remote source');
    this.logToActivity('  2. {bold}load{/bold}      - Process and upload to backend');
    this.logToActivity('  3. {bold}annotate{/bold}  - Detect patterns and create annotations');
    this.logToActivity('  4. {bold}validate{/bold}  - Fetch and verify all resources\n');

    this.logToActivity('{bold}{cyan-fg}═══════════════════════════════════════{/cyan-fg}{/bold}');
    this.logToActivity('{gray-fg}Press any key to continue...{/gray-fg}');
  }

  public run() {
    this.logToActivity('{bold}{cyan-fg}Welcome to Semiont Demo Interactive Mode{/cyan-fg}{/bold}');
    this.logToActivity('{gray-fg}Use ↑/↓ or j/k to navigate, Enter to execute, Tab to switch panels, q to quit{/gray-fg}');
    this.logToActivity('{gray-fg}Press {bold}h{/bold} for help • To select text: Hold Shift (or Option/Alt on Mac) while selecting{/gray-fg}\n');
  }
}
