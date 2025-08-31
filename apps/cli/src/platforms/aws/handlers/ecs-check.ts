import { execSync } from 'child_process';
import { DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { DescribeTargetHealthCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';
import { AWSPlatformStrategy } from '../platform.js';

/**
 * Check ALB target health for ECS service
 */
async function checkALBTargetHealthByArn(platform: AWSPlatformStrategy, targetGroupArn: string, region: string): Promise<string> {
  try {
    const { elb } = platform.getAWSClients(region);
    const response = await elb.send(new DescribeTargetHealthCommand({
      TargetGroupArn: targetGroupArn
    }));
    
    // Check if any targets are healthy
    const healthStates = response.TargetHealthDescriptions?.map(t => t.TargetHealth?.State) || [];
    
    if (healthStates.includes('healthy')) {
      return 'healthy';
    } else if (healthStates.includes('unhealthy')) {
      return 'unhealthy';
    } else if (healthStates.includes('draining')) {
      return 'draining';
    } else {
      return 'unknown';
    }
  } catch (error) {
    // Silently fail - target group might not exist
    return 'unknown';
  }
}

/**
 * ECS service check handler implementation
 */
const ecsCheckHandler = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, cfnDiscoveredResources } = context;
  const { region } = platform.getAWSConfig(service);
  const requirements = service.getRequirements();
  const resourceName = platform.getResourceName(service);
  const accountId = platform.getAccountId(service);
  
  const clusterName = cfnDiscoveredResources.clusterName || `semiont-${service.environment}`;
  const serviceName = cfnDiscoveredResources.serviceName || resourceName;
  
  try {
    const { ecs } = platform.getAWSClients(region);
    const response = await ecs.send(new DescribeServicesCommand({
      cluster: clusterName,
      services: [serviceName]
    }));
    
    const ecsService = response.services?.[0];
    if (ecsService) {
      const runningCount = ecsService.runningCount || 0;
      const desiredCount = ecsService.desiredCount || 0;
      const pendingCount = ecsService.pendingCount || 0;
      
      const status = runningCount > 0 ? 'running' : 'stopped';
      
      // Extract deployment information
      const activeDeployment = ecsService.deployments?.find(d => d.status === 'PRIMARY');
      const isDeploying = ecsService.deployments && ecsService.deployments.length > 1;
      
      // Get current image from task definition
      let currentImage = 'unknown';
      let imageTag = 'unknown';
      if (activeDeployment?.taskDefinition) {
        try {
          const taskDefJson = execSync(
            `aws ecs describe-task-definition --task-definition ${activeDeployment.taskDefinition} --region ${region} --output json`,
            { encoding: 'utf-8' }
          );
          const taskDef = JSON.parse(taskDefJson).taskDefinition;
          const containerDef = taskDef.containerDefinitions?.[0];
          if (containerDef?.image) {
            currentImage = containerDef.image;
            // Extract just the tag from the full image URI
            const tagMatch = currentImage.match(/:([^:]+)$/);
            imageTag = tagMatch ? tagMatch[1] : 'unknown';
          }
        } catch (error) {
          if (service.verbose) {
            console.log(`[DEBUG] Could not get task definition details: ${error}`);
          }
        }
      }
      
      // Check health via ALB target health (if configured)
      let targetHealth = 'unknown';
      let albArn: string | undefined;
      if (requirements.network?.healthCheckPath && ecsService.loadBalancers?.length) {
        const targetGroupArn = ecsService.loadBalancers[0].targetGroupArn;
        albArn = targetGroupArn; // Store for console links
        if (targetGroupArn) {
          targetHealth = await checkALBTargetHealthByArn(platform, targetGroupArn, region);
        }
      }
      
      const health = {
        healthy: targetHealth === 'healthy' || (runningCount === desiredCount && runningCount > 0),
        details: {
          runningCount,
          desiredCount,
          pendingCount,
          targetHealth,
          revision: activeDeployment?.taskDefinition?.split(':').pop(),
          taskDefinition: activeDeployment?.taskDefinition,
          currentImage,
          imageTag,
          deploymentStatus: isDeploying ? '🔄 Deploying' : 'Stable',
          deploymentId: activeDeployment?.id,
          rolloutState: activeDeployment?.rolloutState
        }
      };
      
      const platformResources = createPlatformResources('aws', {
        clusterId: clusterName,
        serviceArn: ecsService.serviceArn || `arn:aws:ecs:${region}:${accountId}:service/${clusterName}/${serviceName}`,
        region: region,
        albArn,
        taskDefinitionArn: activeDeployment?.taskDefinition
      });
      
      // Build ECS-specific metadata
      const metadata: Record<string, any> = {
        ecsClusterName: clusterName,
        ecsServiceName: serviceName,
        currentImage,
        imageTag
      };
      
      // Add deployment status if multiple deployments
      if (isDeploying) {
        const deployments = ecsService.deployments || [];
        metadata.deploymentCount = deployments.length;
        metadata.deployments = deployments.map(d => ({
          id: d.id,
          status: d.status,
          taskDefinition: d.taskDefinition,
          runningCount: d.runningCount,
          desiredCount: d.desiredCount
        }));
      }
      
      // Add ALB and WAF information if available
      if (cfnDiscoveredResources.loadBalancerDns) {
        metadata.loadBalancerDns = cfnDiscoveredResources.loadBalancerDns;
      }
      if (cfnDiscoveredResources.wafWebAclArn) {
        metadata.wafWebAclId = cfnDiscoveredResources.wafWebAclArn;
      }
      if (albArn) {
        metadata.albArn = albArn;
      }
      
      return { 
        success: true,
        status, 
        health, 
        platformResources, 
        metadata 
      };
    } else {
      return { 
        success: true,
        status: 'stopped', 
        metadata: {} 
      };
    }
  } catch (error) {
    // Can't determine status due to error (e.g., expired credentials)
    if (service.verbose) {
      console.log(`[DEBUG] ECS check failed: ${error}`);
    }
    return { 
      success: false,
      status: 'unknown', 
      metadata: {},
      error: `ECS check failed: ${error}`
    };
  }
};

/**
 * ECS check handler descriptor
 * Explicitly declares this handler is for 'check' command on 'ecs-fargate' service type
 */
export const ecsCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  serviceType: 'ecs-fargate',
  handler: ecsCheckHandler,
  requiresDiscovery: true
};