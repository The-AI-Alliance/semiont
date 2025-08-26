/**
 * Command Results Class
 * Collects and formats results from command execution
 */

export class CommandResults {
  private results: Map<string, any> = new Map();
  private errors: string[] = [];
  private warnings: string[] = [];
  private startTime: number;
  
  constructor() {
    this.startTime = Date.now();
  }
  
  /**
   * Add a result for a service
   */
  addResult(serviceName: string, result: any): void {
    this.results.set(serviceName, result);
  }
  
  /**
   * Add an error message
   */
  addError(error: string): void {
    this.errors.push(error);
  }
  
  /**
   * Add a warning message
   */
  addWarning(warning: string): void {
    this.warnings.push(warning);
  }
  
  /**
   * Get all results
   */
  getResults(): any[] {
    return Array.from(this.results.entries()).map(([name, data]) => ({
      service: name,
      data
    }));
  }
  
  /**
   * Get result for a specific service
   */
  getResult(serviceName: string): any {
    return this.results.get(serviceName);
  }
  
  /**
   * Check if any errors occurred
   */
  hasErrors(): boolean {
    return this.errors.length > 0 || 
           Array.from(this.results.values()).some(r => !r.success);
  }
  
  /**
   * Check if all operations succeeded
   */
  isSuccess(): boolean {
    return !this.hasErrors();
  }
  
  /**
   * Get execution duration
   */
  getDuration(): number {
    return Date.now() - this.startTime;
  }
  
  /**
   * Convert to plain object
   */
  toJSON(): any {
    return {
      results: Array.from(this.results.entries()).map(([name, result]) => ({
        service: name,
        ...result
      })),
      errors: this.errors,
      warnings: this.warnings,
      duration: this.getDuration(),
      success: this.isSuccess()
    };
  }
}