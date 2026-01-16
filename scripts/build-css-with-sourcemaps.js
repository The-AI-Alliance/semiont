#!/usr/bin/env node

/**
 * Build CSS with Source Maps
 *
 * This script processes the modular CSS architecture and generates
 * source maps for better debugging experience.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const PACKAGES = [
  {
    name: '@semiont/react-ui',
    input: 'packages/react-ui/src/styles/index.css',
    output: 'packages/react-ui/dist/styles/index.css',
    watch: 'packages/react-ui/src/styles/**/*.css'
  }
];

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function ensureDirectories() {
  PACKAGES.forEach(pkg => {
    const outputDir = path.dirname(pkg.output);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      log(`Created directory: ${outputDir}`, 'green');
    }
  });
}

function checkDependencies() {
  const requiredPackages = [
    'postcss',
    'postcss-cli',
    'postcss-import',
    'autoprefixer'
  ];

  const missingPackages = [];

  requiredPackages.forEach(pkg => {
    try {
      require.resolve(pkg);
    } catch (e) {
      missingPackages.push(pkg);
    }
  });

  if (missingPackages.length > 0) {
    log('Missing required packages:', 'red');
    log(`Run: npm install --save-dev ${missingPackages.join(' ')}`, 'yellow');
    process.exit(1);
  }
}

function buildCSS(pkg, watch = false) {
  const startTime = Date.now();
  log(`Building CSS for ${pkg.name}...`, 'blue');

  try {
    // Build command with postcss-cli
    let command = `npx postcss ${pkg.input} -o ${pkg.output}`;

    // Add watch flag if needed
    if (watch) {
      command += ` --watch --verbose`;
    }

    // Add environment variable for production builds
    if (process.env.NODE_ENV === 'production') {
      command = `NODE_ENV=production ${command}`;
    }

    // Execute build
    if (watch) {
      log(`Watching ${pkg.watch}...`, 'yellow');
      // For watch mode, use spawn instead of execSync
      const spawn = require('child_process').spawn;
      const child = spawn('sh', ['-c', command], { stdio: 'inherit' });

      child.on('error', (err) => {
        log(`Error: ${err.message}`, 'red');
      });

      // Handle process termination
      process.on('SIGINT', () => {
        child.kill('SIGINT');
        process.exit(0);
      });
    } else {
      execSync(command, { stdio: 'inherit' });

      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(2);

      // Check output files
      const cssSize = fs.statSync(pkg.output).size;
      const mapFile = pkg.output + '.map';
      const hasMap = fs.existsSync(mapFile);
      const mapSize = hasMap ? fs.statSync(mapFile).size : 0;

      log(`✅ ${pkg.name} built successfully in ${duration}s`, 'green');
      log(`   CSS: ${(cssSize / 1024).toFixed(2)} KB`, 'green');
      if (hasMap) {
        log(`   Source Map: ${(mapSize / 1024).toFixed(2)} KB`, 'green');
      }

      // Validate source map reference
      const cssContent = fs.readFileSync(pkg.output, 'utf8');
      if (cssContent.includes('/*# sourceMappingURL=')) {
        log(`   ✓ Source map reference added`, 'green');
      } else if (process.env.NODE_ENV !== 'production') {
        log(`   ⚠ No source map reference found (expected in dev mode)`, 'yellow');
      }
    }
  } catch (error) {
    log(`Failed to build ${pkg.name}: ${error.message}`, 'red');
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const watch = args.includes('--watch') || args.includes('-w');
  const isProduction = args.includes('--production') || args.includes('-p');

  if (isProduction) {
    process.env.NODE_ENV = 'production';
    log('Building for production (optimized, no source map references)', 'yellow');
  } else {
    process.env.NODE_ENV = 'development';
    log('Building for development (with source maps)', 'yellow');
  }

  log('CSS Build with Source Maps', 'blue');
  log('=' .repeat(50), 'blue');

  // Check dependencies
  checkDependencies();

  // Ensure output directories exist
  ensureDirectories();

  // Build each package
  PACKAGES.forEach(pkg => buildCSS(pkg, watch));

  if (!watch) {
    log('\n' + '=' .repeat(50), 'blue');
    log('All CSS packages built successfully!', 'green');
    log('\nTo use source maps:', 'yellow');
    log('1. Open browser DevTools', 'yellow');
    log('2. Navigate to Sources/Styles tab', 'yellow');
    log('3. You should see original .css files', 'yellow');
    log('\nFor production builds, run:', 'yellow');
    log('npm run build:css:prod', 'yellow');
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}