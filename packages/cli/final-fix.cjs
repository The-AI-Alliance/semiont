#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const files = [
  'commands/check.ts',
  'commands/exec.ts',
  'commands/restart.ts',
  'commands/start.ts',
  'commands/test.ts',
  'commands/update.ts',
  'commands/watch.ts'
];

files.forEach(file => {
  const filePath = path.join(__dirname, file);
  let content = fs.readFileSync(filePath, 'utf-8');
  
  // Fix all debugLog functions that call the wrong thing
  content = content.replace(
    /function debugLog\(message: string, options: \w+\): void \{[\s\S]*?\}/g,
    (match) => {
      // Extract the options type
      const typeMatch = match.match(/options: (\w+)/);
      const optionsType = typeMatch ? typeMatch[1] : 'any';
      
      return `function debugLog(message: string, options: ${optionsType}): void {\n  // Debug logging disabled for now\n}`;
    }
  );
  
  // Add printDebug import to update.ts if missing
  if (file === 'commands/update.ts' && !content.includes('printDebug')) {
    content = content.replace(
      "import { printError, printSuccess, printInfo, printWarning } from '../lib/cli-logger.js';",
      "import { printError, printSuccess, printInfo, printWarning, printDebug } from '../lib/cli-logger.js';"
    );
  }
  
  fs.writeFileSync(filePath, content);
  console.log(`✅ Fixed ${file}`);
});

console.log('\n✅ Done!');