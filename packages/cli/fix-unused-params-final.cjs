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
  
  // Fix all debugLog functions with unused parameters
  content = content.replace(
    /function debugLog\(message: string, options: \w+\): void \{/g,
    'function debugLog(_message: string, _options: any): void {'
  );
  
  // Fix the specific printDebug calls in update.ts
  if (file === 'commands/update.ts') {
    content = content.replace(
      /printDebug\(message, options\.verbose \|\| false\);/g,
      '// Debug logging disabled'
    );
    content = content.replace(
      /debugLog\(`Waiting \$\{gracePeriod\} seconds before starting\.\.\.`, options\);/g,
      '// Debug: Waiting gracePeriod seconds before starting...'
    );
    content = content.replace(
      /debugLog\(`Waiting \$\{processGracePeriod\} seconds before starting\.\.\.`, options\);/g,
      '// Debug: Waiting processGracePeriod seconds before starting...'
    );
  }
  
  // Fix unreachable code in watch.ts
  if (file === 'commands/watch.ts') {
    // Remove the if (false) block entirely
    content = content.replace(
      /if \(false\) \{ \/\/ Structured output mode check removed[\s\S]*?setTimeout[\s\S]*?\}, 1000\);[\s\S]*?return;[\s\S]*?\}/,
      '// Structured output mode check removed'
    );
  }
  
  fs.writeFileSync(filePath, content);
  console.log(`✅ Fixed ${file}`);
});

console.log('\n✅ Done!');