/**
 * Dependency Graph - Manages package build order
 */

export interface PackageInfo {
  name: string;
  path: string;
  dependencies: string[];
}

export class DependencyGraph {
  private packages: Map<string, PackageInfo> = new Map();

  constructor() {
    this.initializePackages();
  }

  private initializePackages(): void {
    // Define packages and their dependencies in build order
    this.packages.set('api-types', {
      name: 'API Types',
      path: 'packages/api-types',
      dependencies: []
    });

    this.packages.set('config-loader', {
      name: 'Config Loader', 
      path: 'packages/config-loader',
      dependencies: []
    });

    this.packages.set('backend', {
      name: 'Backend',
      path: 'apps/backend',
      dependencies: ['api-types', 'config-loader']
    });

    this.packages.set('frontend', {
      name: 'Frontend',
      path: 'apps/frontend', 
      dependencies: ['api-types']
    });

    this.packages.set('cli', {
      name: 'CLI',
      path: 'packages/cli',
      dependencies: ['config-loader']
    });
  }

  /**
   * Get packages in dependency order for building
   */
  getBuildOrder(includeAll: boolean = true): PackageInfo[] {
    if (includeAll) {
      // Return all packages in dependency order
      return [
        this.packages.get('api-types')!,
        this.packages.get('config-loader')!,
        this.packages.get('backend')!,
        this.packages.get('frontend')!,
        this.packages.get('cli')!
      ];
    } else {
      // CLI-only mode: just CLI and its dependencies
      return [
        this.packages.get('config-loader')!,
        this.packages.get('cli')!
      ];
    }
  }

  /**
   * Get packages that need to be cleaned
   */
  getPackagesForCleaning(): PackageInfo[] {
    return Array.from(this.packages.values());
  }

  /**
   * Check if a package exists in the graph
   */
  hasPackage(packageName: string): boolean {
    return this.packages.has(packageName);
  }

  /**
   * Get package info by name
   */
  getPackage(packageName: string): PackageInfo | undefined {
    return this.packages.get(packageName);
  }
}