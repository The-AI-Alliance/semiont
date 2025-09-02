import { execSync } from 'child_process';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';

/**
 * Get CloudFront distribution ID for a given S3 bucket
 */
async function getCloudFrontDistribution(bucketName: string, region: string): Promise<string | undefined> {
  try {
    const distributionId = execSync(
      `aws cloudfront list-distributions --query "DistributionList.Items[?Origins.Items[?DomainName=='${bucketName}.s3.amazonaws.com']].Id | [0]" --output text --region ${region}`,
      { encoding: 'utf-8' }
    ).trim();
    return distributionId !== 'None' ? distributionId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get CloudFront distribution status
 */
async function getCloudFrontStatus(distributionId: string, region: string): Promise<string> {
  try {
    const status = execSync(
      `aws cloudfront get-distribution --id ${distributionId} --query 'Distribution.Status' --output text --region ${region}`,
      { encoding: 'utf-8' }
    ).trim();
    return status;
  } catch {
    return 'Unknown';
  }
}

/**
 * S3 + CloudFront check handler implementation
 */
const s3CloudFrontCheckHandler = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service, region, resourceName } = context;
  
  const bucketName = `${resourceName}-static`;
  
  try {
    // Check if bucket exists
    execSync(`aws s3api head-bucket --bucket ${bucketName} --region ${region} 2>/dev/null`);
    const status = 'running';
    
    let health;
    let distributionId: string | undefined;
    
    // Check CloudFront distribution status
    distributionId = await getCloudFrontDistribution(bucketName, region);
    if (distributionId) {
      const distStatus = await getCloudFrontStatus(distributionId, region);
      health = {
        healthy: distStatus === 'Deployed',
        details: {
          bucket: bucketName,
          distributionId,
          status: distStatus
        }
      };
    } else {
      // No CloudFront distribution, just S3
      health = {
        healthy: true,
        details: {
          bucket: bucketName,
          status: 'S3 only (no CloudFront)'
        }
      };
    }
    
    const platformResources = createPlatformResources('aws', {
      bucketName,
      distributionId,
      region: region
    });
    
    // Build S3-CloudFront specific metadata
    const metadata: Record<string, any> = {
      s3BucketName: bucketName
    };
    
    if (distributionId) {
      metadata.cloudFrontDistributionId = distributionId;
    }
    
    return { 
      success: true,
      status, 
      health, 
      platformResources, 
      metadata 
    };
  } catch (error) {
    // Can't determine status due to error (e.g., expired credentials)
    if (service.verbose) {
      console.log(`[DEBUG] S3/CloudFront check failed: ${error}`);
    }
    return { 
      success: false,
      status: 'unknown', 
      metadata: {},
      error: `S3/CloudFront check failed: ${error}`
    };
  }
};

/**
 * S3-CloudFront check handler descriptor
 * Explicitly declares this handler is for 'check' command on 's3-cloudfront' service type
 */
export const s3CloudFrontCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'aws',
  serviceType: 's3-cloudfront',
  handler: s3CloudFrontCheckHandler
};