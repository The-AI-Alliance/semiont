/**
 * Progress Reporter - Colored terminal output for installation process
 */

export class ProgressReporter {
  private verbose: boolean;
  
  // Color codes
  private colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
  };

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  showBanner(cliOnly: boolean): void {
    if (cliOnly) {
      console.log(`${this.colors.blue}🚀 Semiont CLI Installation${this.colors.reset}`);
      console.log('================================');
      console.log('This will:');
      console.log('  • Build and install the semiont CLI only');
      console.log('');
      console.log('For full installation (all packages), run without --cli-only');
    } else {
      console.log(`${this.colors.blue}🚀 Semiont Full Installation${this.colors.reset}`);
      console.log('================================');
      console.log('This will:');
      console.log('  • Install all dependencies');
      console.log('  • Build all packages (api-types, backend, frontend, cloud, cli, scripts)');
      console.log('  • Install the semiont CLI globally');
      console.log('');
      console.log('For CLI-only installation, run: npm run setup -- --cli-only');
    }
    console.log('');
  }

  showStep(step: number, total: number, message: string): void {
    console.log(`${this.colors.cyan}[${step}/${total}]${this.colors.reset} ${this.colors.blue}${message}${this.colors.reset}`);
  }

  showSuccess(message: string): void {
    console.log(`${this.colors.green}✓ ${message}${this.colors.reset}`);
  }

  showWarning(message: string): void {
    console.log(`${this.colors.yellow}⚠️  ${message}${this.colors.reset}`);
  }

  showError(title: string, message: string): void {
    console.error(`${this.colors.red}❌ ${title}${this.colors.reset}`);
    if (message) {
      console.error(`   ${message}`);
    }
  }

  showInfo(message: string): void {
    console.log(`${this.colors.blue}ℹ️  ${message}${this.colors.reset}`);
  }

  showVerbose(message: string): void {
    if (this.verbose) {
      console.log(`${this.colors.cyan}[DEBUG] ${message}${this.colors.reset}`);
    }
  }

  showSuccessSummary(): void {
    console.log('');
    console.log(`${this.colors.green}================================${this.colors.reset}`);
    console.log(`${this.colors.green}✅ Installation Complete!${this.colors.reset}`);
    console.log(`${this.colors.green}================================${this.colors.reset}`);
    console.log('');
    
    // Verify CLI installation
    console.log(`${this.colors.green}Semiont CLI installed globally${this.colors.reset}`);
    console.log('');
    console.log(`${this.colors.cyan}Quick Start:${this.colors.reset}`);
    console.log('  semiont provision -e local   # Setup local environment');
    console.log('  semiont start -e local       # Start services');
    console.log('  semiont check -e local       # Check system health');
    console.log('  semiont --help               # Show all commands');
    console.log('');
    console.log(`${this.colors.cyan}Development:${this.colors.reset}`);
    console.log('  npm run dev                  # Start all dev servers (from root)');
    console.log('  npm test                     # Run all unit tests');
    console.log('');
    console.log('To set a default environment:');
    console.log('  export SEMIONT_ENV=local');
  }
}