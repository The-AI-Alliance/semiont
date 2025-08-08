import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

export interface AWSCredentialsValidationResult {
  valid: boolean;
  identity?: {
    account: string;
    arn: string;
    userId: string;
  };
  error?: string;
}

/**
 * Validates AWS credentials by attempting to get caller identity
 * This is a quick, lightweight check that fails fast if credentials are invalid
 */
export async function validateAWSCredentials(region: string): Promise<AWSCredentialsValidationResult> {
  try {
    const stsClient = new STSClient({ region });
    const command = new GetCallerIdentityCommand({});
    
    const response = await stsClient.send(command);
    
    return {
      valid: true,
      identity: {
        account: response.Account || 'unknown',
        arn: response.Arn || 'unknown',
        userId: response.UserId || 'unknown'
      }
    };
  } catch (error: any) {
    let errorMessage = 'Unknown AWS credentials error';
    
    if (error.name === 'CredentialsProviderError') {
      if (error.message.includes('Token is expired')) {
        errorMessage = "AWS SSO token is expired. Run 'aws sso login' to refresh your credentials.";
      } else if (error.message.includes('No credentials')) {
        errorMessage = "No AWS credentials found. Run 'aws configure' or 'aws sso login' to set up credentials.";
      } else {
        errorMessage = `AWS credentials error: ${error.message}`;
      }
    } else if (error.name === 'UnauthorizedOperation' || error.name === 'AccessDenied') {
      errorMessage = `AWS access denied: ${error.message}`;
    } else {
      errorMessage = `AWS error: ${error.message}`;
    }
    
    return {
      valid: false,
      error: errorMessage
    };
  }
}

/**
 * Validates AWS credentials and exits the process if invalid
 * Use this at the start of scripts that require AWS access
 */
export async function requireValidAWSCredentials(region: string): Promise<void> {
  console.log(`🔐 Validating AWS credentials...`);
  
  const result = await validateAWSCredentials(region);
  
  if (!result.valid) {
    console.error(`❌ CRITICAL: AWS credentials validation failed`);
    console.error(`   ${result.error}`);
    console.error(`   Please fix your AWS credentials and try again.`);
    process.exit(1);
  }
  
  console.log(`✅ AWS credentials valid (Account: ${result.identity?.account})`);
}