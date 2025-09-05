/**
 * AWS Credential Validator
 * 
 * Validates AWS credentials before attempting to use AWS services.
 * Provides helpful error messages for common credential issues.
 */

import { execSync } from 'child_process';

export interface CredentialCheckResult {
  valid: boolean;
  error?: string;
  ssoExpired?: boolean;
  profileMissing?: boolean;
  region?: string;
  accountId?: string;
}

/**
 * Validate AWS credentials by attempting an API call
 */
export async function validateAWSCredentials(_environment: string): Promise<CredentialCheckResult> {
  try {
    // Just try to get caller identity using whatever credentials are available
    // Don't specify a profile - let AWS SDK use its standard credential chain
    const output = execSync(`aws sts get-caller-identity --output json 2>&1`, {
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        // AWS SDK will use these in order:
        // 1. Environment variables (AWS_ACCESS_KEY_ID, etc.)
        // 2. AWS_PROFILE environment variable
        // 3. Default profile
        // 4. Instance metadata (if on EC2)
      }
    });
    
    const identity = JSON.parse(output);
    
    // Get the region from environment or default
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    
    return {
      valid: true,
      accountId: identity.Account,
      region
    };
  } catch (error: any) {
    const errorStr = error.toString();
    
    // Check for SSO token expiration
    if (errorStr.includes('Token is expired') || errorStr.includes('SSO session expired')) {
      return {
        valid: false,
        error: 'AWS SSO session expired',
        ssoExpired: true
      };
    }
    
    // Check for missing credentials
    if (errorStr.includes('Unable to locate credentials') || errorStr.includes('could not find credentials')) {
      return {
        valid: false,
        error: 'No AWS credentials configured',
        profileMissing: true
      };
    }
    
    // Generic error - just return a simple message
    return {
      valid: false,
      error: 'AWS credentials not available or expired'
    };
  }
}

/**
 * Check if AWS CLI is installed
 */
export function isAWSCliInstalled(): boolean {
  try {
    execSync('aws --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of configured AWS profiles
 */
export function getAWSProfiles(): string[] {
  try {
    const output = execSync('aws configure list-profiles', {
      stdio: 'pipe',
      encoding: 'utf8'
    });
    return output.split('\n').filter(line => line.trim());
  } catch {
    return [];
  }
}