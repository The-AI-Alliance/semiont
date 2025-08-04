#!/usr/bin/env node

/**
 * Performance Monitoring Script
 * 
 * Comprehensive performance analysis and monitoring for the frontend application.
 * Provides actionable insights and recommendations for optimization.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Load performance configuration
const perfConfig = require('../performance.config.js');

class PerformanceMonitor {
  constructor() {
    this.results = {
      bundleAnalysis: null,
      lighthouseReport: null,
      recommendations: [],
      warnings: [],
      errors: []
    };
  }

  async run() {
    console.log('🚀 Starting Performance Monitoring...\n');
    
    try {
      await this.analyzeBundleSize();
      await this.runLighthouseAnalysis();
      await this.generateRecommendations();
      await this.generateReport();
      
      console.log('✅ Performance monitoring complete!\n');
      this.printSummary();
      
    } catch (error) {
      console.error('❌ Performance monitoring failed:', error.message);
      process.exit(1);
    }
  }

  async analyzeBundleSize() {
    console.log('📦 Analyzing bundle size...');
    
    try {
      // Build with analysis
      execSync('npm run build', { stdio: 'pipe' });
      
      // Check build output
      const buildOutputPath = path.join(__dirname, '../.next');
      if (fs.existsSync(buildOutputPath)) {
        console.log('✅ Bundle analysis complete');
        this.results.bundleAnalysis = this.analyzeBuildOutput(buildOutputPath);
      }
      
    } catch (error) {
      this.results.errors.push(`Bundle analysis failed: ${error.message}`);
    }
  }

  analyzeBuildOutput(buildPath) {
    // Analyze the Next.js build output
    const buildManifest = path.join(buildPath, 'BUILD_ID');
    const staticPath = path.join(buildPath, 'static');
    
    if (!fs.existsSync(staticPath)) {
      return { error: 'Build output not found' };
    }

    const analysis = {
      totalSize: 0,
      jsSize: 0,
      cssSize: 0,
      chunks: [],
      assets: []
    };

    // Recursively analyze files
    const analyzeDirectory = (dirPath, relativePath = '') => {
      const items = fs.readdirSync(dirPath);
      
      items.forEach(item => {
        const fullPath = path.join(dirPath, item);
        const relativeItemPath = path.join(relativePath, item);
        const stats = fs.statSync(fullPath);
        
        if (stats.isDirectory()) {
          analyzeDirectory(fullPath, relativeItemPath);
        } else {
          const size = stats.size;
          analysis.totalSize += size;
          
          if (item.endsWith('.js')) {
            analysis.jsSize += size;
          } else if (item.endsWith('.css')) {
            analysis.cssSize += size;
          }
          
          analysis.assets.push({
            name: relativeItemPath,
            size: size,
            type: path.extname(item).slice(1)
          });
        }
      });
    };
    
    analyzeDirectory(staticPath);
    
    // Check against thresholds
    if (analysis.totalSize > perfConfig.bundleSize.maxTotalSize) {
      this.results.warnings.push(
        `Bundle size (${(analysis.totalSize / 1024 / 1024).toFixed(2)}MB) exceeds maximum (${(perfConfig.bundleSize.maxTotalSize / 1024 / 1024).toFixed(2)}MB)`
      );
    }
    
    return analysis;
  }

  async runLighthouseAnalysis() {
    console.log('💡 Running Lighthouse analysis...');
    
    try {
      // Check if Lighthouse CI is configured
      const lhciPath = path.join(__dirname, '../lighthouserc.json');
      if (!fs.existsSync(lhciPath)) {
        this.results.warnings.push('Lighthouse CI not configured');
        return;
      }
      
      // Note: In a real scenario, you'd start the server and run lighthouse
      console.log('ℹ️  Lighthouse analysis would run here (requires running server)');
      this.results.lighthouseReport = { 
        note: 'Run `npm run lighthouse` with server running for full analysis' 
      };
      
    } catch (error) {
      this.results.errors.push(`Lighthouse analysis failed: ${error.message}`);
    }
  }

  generateRecommendations() {
    console.log('💡 Generating performance recommendations...');
    
    const { bundleAnalysis } = this.results;
    
    if (!bundleAnalysis || bundleAnalysis.error) {
      return;
    }
    
    // Bundle size recommendations
    if (bundleAnalysis.totalSize > perfConfig.bundleSize.maxTotalSize * perfConfig.bundleSize.warningThreshold) {
      this.results.recommendations.push({
        type: 'bundle-size',
        priority: 'high',
        title: 'Optimize Bundle Size',
        description: 'Your bundle is approaching the size limit',
        actions: [
          'Enable tree shaking for unused code',
          'Use dynamic imports for large components',
          'Analyze and replace large dependencies',
          'Consider code splitting strategies'
        ]
      });
    }
    
    // Large assets recommendations
    const largeAssets = bundleAnalysis.assets
      .filter(asset => asset.size > perfConfig.suggestions.dynamicImportThreshold)
      .sort((a, b) => b.size - a.size);
    
    if (largeAssets.length > 0) {
      this.results.recommendations.push({
        type: 'large-assets',
        priority: 'medium',
        title: 'Optimize Large Assets',
        description: `Found ${largeAssets.length} large assets that could be optimized`,
        actions: [
          'Consider lazy loading for large components',
          'Compress images and assets',
          'Use next/dynamic for code splitting',
          'Implement progressive loading'
        ],
        assets: largeAssets.slice(0, 5) // Top 5 largest
      });
    }
    
    // CSS optimization
    if (bundleAnalysis.cssSize > perfConfig.bundleSize.maxCssSize) {
      this.results.recommendations.push({
        type: 'css-optimization',
        priority: 'medium',
        title: 'Optimize CSS Bundle',
        description: 'CSS bundle size is larger than recommended',
        actions: [
          'Remove unused CSS classes',
          'Use CSS-in-JS for component-specific styles',
          'Consider CSS purging tools',
          'Optimize Tailwind CSS configuration'
        ]
      });
    }
    
    // General performance recommendations
    this.results.recommendations.push({
      type: 'general',
      priority: 'low',
      title: 'General Performance Best Practices',
      description: 'Recommended optimizations for better performance',
      actions: [
        'Implement proper caching strategies',
        'Use Next.js Image component for all images',
        'Enable gzip/brotli compression',
        'Optimize database queries and API responses',
        'Consider implementing service workers'
      ]
    });
  }

  generateReport() {
    const reportDir = perfConfig.analysis.outputDir;
    
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }
    
    const report = {
      timestamp: new Date().toISOString(),
      results: this.results,
      configuration: perfConfig
    };
    
    const reportPath = path.join(reportDir, `performance-report-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    console.log(`📊 Performance report saved to: ${reportPath}`);
  }

  printSummary() {
    console.log('📋 Performance Summary');
    console.log('=====================');
    
    if (this.results.bundleAnalysis && !this.results.bundleAnalysis.error) {
      const { totalSize, jsSize, cssSize } = this.results.bundleAnalysis;
      console.log(`📦 Total Bundle Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(`📄 JavaScript Size: ${(jsSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(`🎨 CSS Size: ${(cssSize / 1024).toFixed(2)} KB`);
    }
    
    if (this.results.warnings.length > 0) {
      console.log(`\n⚠️  Warnings (${this.results.warnings.length}):`);
      this.results.warnings.forEach(warning => console.log(`   • ${warning}`));
    }
    
    if (this.results.errors.length > 0) {
      console.log(`\n❌ Errors (${this.results.errors.length}):`);
      this.results.errors.forEach(error => console.log(`   • ${error}`));
    }
    
    if (this.results.recommendations.length > 0) {
      console.log(`\n💡 Recommendations (${this.results.recommendations.length}):`);
      this.results.recommendations.forEach(rec => {
        console.log(`   ${rec.priority === 'high' ? '🔴' : rec.priority === 'medium' ? '🟡' : '🟢'} ${rec.title}`);
      });
    }
    
    console.log('\n🚀 Next Steps:');
    console.log('   1. Review detailed recommendations in the report');
    console.log('   2. Run bundle analyzer: npm run analyze');
    console.log('   3. Run Lighthouse: npm run lighthouse');
    console.log('   4. Monitor performance regularly in CI/CD');
  }
}

// Run the performance monitor
if (require.main === module) {
  const monitor = new PerformanceMonitor();
  monitor.run().catch(console.error);
}

module.exports = PerformanceMonitor;