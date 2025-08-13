#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// List of command files that need refactoring
const filesToRefactor = [
  'commands/start.ts',
  'commands/restart.ts',
  'commands/check.ts',
  'commands/configure.ts',
  'commands/exec.ts',
  'commands/test.ts',
  'commands/watch.ts'
];

function refactorFile(filePath) {
  console.log(`Refactoring ${filePath}...`);
  
  let content = fs.readFileSync(filePath, 'utf-8');
  
  // Check if already refactored
  if (content.includes('cli-logger.js')) {
    console.log(`  Already refactored, skipping.`);
    return;
  }
  
  // Add import for cli-logger
  const hasColors = content.includes("import { colors } from '../lib/cli-colors.js';");
  if (hasColors) {
    content = content.replace(
      "import { colors } from '../lib/cli-colors.js';",
      "import { colors } from '../lib/cli-colors.js';\nimport { printError, printSuccess, printInfo, printWarning, printDebug, setSuppressOutput } from '../lib/cli-logger.js';"
    );
  } else {
    // Add both imports after the first import
    const firstImportMatch = content.match(/^import .* from .*;$/m);
    if (firstImportMatch) {
      const insertPos = content.indexOf(firstImportMatch[0]) + firstImportMatch[0].length;
      content = content.slice(0, insertPos) + 
        "\nimport { colors } from '../lib/cli-colors.js';" +
        "\nimport { printError, printSuccess, printInfo, printWarning, printDebug, setSuppressOutput } from '../lib/cli-logger.js';" +
        content.slice(insertPos);
    }
  }
  
  // Remove the duplicated print functions and suppressOutput flag
  const helperFunctionsRegex = /\/\/ =+\n\/\/ HELPER FUNCTIONS\n\/\/ =+\n\n\/\/ Global flag.*?\n\nfunction printDebug\(.*?\n\}\n\n/s;
  const match = content.match(helperFunctionsRegex);
  
  if (match) {
    // Extract the options type from the printDebug function
    const optionsTypeMatch = match[0].match(/printDebug\(message: string, options: (\w+)\)/);
    const optionsType = optionsTypeMatch ? optionsTypeMatch[1] : 'any';
    
    // Replace with a simple helper wrapper
    const replacement = `// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

// Helper wrapper for printDebug that passes verbose option
function debugLog(message: string, options: ${optionsType}): void {
  printDebug(message, options.verbose || false);
}

`;
    
    content = content.replace(match[0], replacement);
    
    // Replace all printDebug calls with debugLog
    content = content.replace(/printDebug\(/g, 'debugLog(');
    
    // Replace suppressOutput assignments
    content = content.replace(
      /const previousSuppressOutput = suppressOutput;\s*\n\s*suppressOutput = isStructuredOutput;/g,
      'const previousSuppressOutput = setSuppressOutput(isStructuredOutput);'
    );
    
    // Replace suppressOutput restore
    content = content.replace(
      /suppressOutput = previousSuppressOutput;/g,
      'setSuppressOutput(previousSuppressOutput);'
    );
  }
  
  // Write the refactored content
  fs.writeFileSync(filePath, content);
  console.log(`  ✅ Refactored successfully`);
}

// Main execution
console.log('Starting refactoring of CLI command files...\n');

for (const file of filesToRefactor) {
  const fullPath = path.join(__dirname, file);
  if (fs.existsSync(fullPath)) {
    try {
      refactorFile(fullPath);
    } catch (error) {
      console.error(`  ❌ Error refactoring ${file}: ${error.message}`);
    }
  } else {
    console.log(`  ⚠️  File not found: ${file}`);
  }
}

console.log('\n✅ Refactoring complete!');