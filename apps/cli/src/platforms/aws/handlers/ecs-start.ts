import { execSync } from 'child_process';
import { StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';

/**
 * Start handler for ECS services (Fargate and EC2)
 */
const startECSService = async (context: StartHandlerContext): Promise<StartHandlerResult> => {
  const { service, cfnDiscoveredResources, accountId, region } = context;
  const requirements = service.getRequirements();
  const resourceName = `semiont-${service.name}-${service.environment}`;
  
  // Get cluster and service names from discovered resources
  const clusterName = cfnDiscoveredResources?.clusterName || `semiont-${service.environment}`;
  const serviceName = cfnDiscoveredResources?.serviceName || resourceName;
  const desiredCount = requirements.resources?.replicas || 1;
  
  try {
    execSync(
      `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --desired-count ${desiredCount} --region ${region}`,
      { encoding: 'utf-8' }
    );
    
    // Get service endpoint from load balancer
    let endpoint: string | undefined;
    if (requirements.network?.needsLoadBalancer) {
      try {
        const albDns = execSync(
          `aws elbv2 describe-load-balancers --names ${serviceName}-alb --query 'LoadBalancers[0].DNSName' --output text --region ${region}`,
          { encoding: 'utf-8' }
        ).trim();
        
        if (albDns && albDns !== 'None') {
          endpoint = `https://${albDns}`;
        }
      } catch {
        // ALB might not exist yet
      }
    }
    
    const resources = createPlatformResources('aws', {
      clusterId: clusterName,
      serviceArn: `arn:aws:ecs:${region}:${accountId}:service/${clusterName}/${serviceName}`,
      region: region
    });
    
    return {
      success: true,
      endpoint,
      resources,
      metadata: {
        serviceType: 'ecs-fargate',
        region,
        resourceName,
        clusterName,
        serviceName,
        desiredCount
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to start ECS service: ${error}`,
      metadata: {
        serviceType: 'ecs-fargate',
        region,
        clusterName,
        serviceName
      }
    };
  }
};

/**
 * Descriptor for ECS Fargate start handler
 */
export const ecsFargateStartDescriptor: HandlerDescriptor<StartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'aws',
  serviceType: 'ecs-fargate',
  handler: startECSService,
  requiresDiscovery: true
};

// Also export as 'ecs' (shorter alias)
export const ecsStartDescriptor: HandlerDescriptor<StartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'aws',
  serviceType: 'ecs',
  handler: startECSService,
  requiresDiscovery: true
};