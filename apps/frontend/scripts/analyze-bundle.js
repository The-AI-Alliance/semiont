#!/usr/bin/env node

/**
 * Bundle Analysis Script
 * 
 * This script provides comprehensive bundle analysis including:
 * - Bundle size comparison
 * - Dependency analysis
 * - Performance recommendations
 * - Bundle visualization
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔍 Starting Bundle Analysis...\n');

// Build with analysis
console.log('📦 Building application with bundle analyzer...');
try {
  execSync('npm run analyze', { stdio: 'inherit' });
} catch (error) {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
}

// Check if stats file exists
const statsPath = path.join(__dirname, '../bundle-stats.json');
if (fs.existsSync(statsPath)) {
  const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  
  console.log('\n📊 Bundle Analysis Summary:');
  console.log('=====================================');
  
  // Analyze chunks
  const chunks = stats.chunks || [];
  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  
  console.log(`Total Bundle Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Number of Chunks: ${chunks.length}`);
  
  // Find largest chunks
  const largestChunks = chunks
    .sort((a, b) => b.size - a.size)
    .slice(0, 5);
  
  console.log('\n🏆 Largest Chunks:');
  largestChunks.forEach((chunk, index) => {
    const sizeMB = (chunk.size / 1024 / 1024).toFixed(2);
    console.log(`${index + 1}. ${chunk.names?.[0] || chunk.id}: ${sizeMB} MB`);
  });
  
  // Analyze modules
  const modules = stats.modules || [];
  const nodeModules = modules.filter(m => m.name?.includes('node_modules'));
  const ownModules = modules.filter(m => !m.name?.includes('node_modules'));
  
  console.log('\n📚 Module Analysis:');
  console.log(`Own Modules: ${ownModules.length}`);
  console.log(`Third-party Modules: ${nodeModules.length}`);
  
  // Find largest dependencies
  const dependencySize = {};
  nodeModules.forEach(mod => {
    const match = mod.name?.match(/node_modules\/([^\/]+)/);
    if (match) {
      const dep = match[1];
      dependencySize[dep] = (dependencySize[dep] || 0) + mod.size;
    }
  });
  
  const largestDeps = Object.entries(dependencySize)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10);
  
  console.log('\n📦 Largest Dependencies:');
  largestDeps.forEach(([dep, size], index) => {
    const sizeMB = (size / 1024 / 1024).toFixed(2);
    console.log(`${index + 1}. ${dep}: ${sizeMB} MB`);
  });
  
  // Performance recommendations
  console.log('\n💡 Performance Recommendations:');
  console.log('================================');
  
  if (totalSize > 1024 * 1024 * 2) { // > 2MB
    console.log('⚠️  Large bundle size detected. Consider:');
    console.log('   - Code splitting with dynamic imports');
    console.log('   - Tree shaking unused dependencies');
    console.log('   - Analyzing and replacing large dependencies');
  }
  
  if (chunks.length > 20) {
    console.log('⚠️  Many chunks detected. Consider:');
    console.log('   - Optimizing chunk splitting strategy');
    console.log('   - Combining small chunks');
  }
  
  const reactQuerySize = dependencySize['@tanstack/react-query'] || 0;
  if (reactQuerySize > 100 * 1024) { // > 100KB
    console.log('💡 React Query is large. Consider using only needed parts.');
  }
  
  console.log('\n✅ Analysis complete! Check bundle-report.html for detailed visualization.');
  
} else {
  console.log('⚠️  Bundle stats file not found. Analysis may be incomplete.');
}

// Provide next steps
console.log('\n🚀 Next Steps:');
console.log('==============');
console.log('1. Open bundle-report.html in your browser');
console.log('2. Run Lighthouse analysis: npm run lighthouse');
console.log('3. Check for unused dependencies: npx depcheck');
console.log('4. Analyze duplicates: npx duplicate-package-checker-webpack');