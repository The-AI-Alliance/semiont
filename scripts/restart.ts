#!/usr/bin/env -S npx tsx

import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { SemiontStackConfig } from './lib/stack-config';
import { config } from '../config';

const stackConfig = new SemiontStackConfig();
const ecsClient = new ECSClient({ region: config.aws.region });

async function restartService(service: 'frontend' | 'backend', serviceName: string, clusterName: string) {
  const serviceIcon = service === 'frontend' ? '📱' : '🚀';
  console.log(`🔄 ${serviceIcon} Restarting ${service} service...`);

  await ecsClient.send(
    new UpdateServiceCommand({
      cluster: clusterName,
      service: serviceName,
      forceNewDeployment: true,
    })
  );

  console.log(`✅ ${serviceIcon} ${service} restart initiated successfully`);
}

async function restartServices(targetService?: 'frontend' | 'backend' | 'both') {
  console.log(`🔄 Restarting ${config.site.siteName} services...`);

  try {
    const clusterName = await stackConfig.getClusterName();
    const services: Array<{type: 'frontend' | 'backend', name: string}> = [];

    // Determine which services to restart
    if (!targetService || targetService === 'both') {
      services.push(
        { type: 'frontend', name: await stackConfig.getFrontendServiceName() },
        { type: 'backend', name: await stackConfig.getBackendServiceName() }
      );
    } else if (targetService === 'frontend') {
      services.push({ type: 'frontend', name: await stackConfig.getFrontendServiceName() });
    } else if (targetService === 'backend') {
      services.push({ type: 'backend', name: await stackConfig.getBackendServiceName() });
    }

    // Restart services
    for (const service of services) {
      await restartService(service.type, service.name, clusterName);
    }

    console.log('');
    console.log('⏱️  Restart will take 2-3 minutes to complete');
    console.log('');
    console.log('💡 Monitor progress with:');
    console.log('   ./scripts/semiont status           # Check overall status');
    console.log('   ./scripts/semiont logs frontend tail  # Check frontend logs');
    console.log('   ./scripts/semiont logs backend tail   # Check backend logs');
    console.log('   ./scripts/semiont logs follow         # Follow all logs');

  } catch (error: any) {
    console.error('❌ Failed to restart service:', error.message);
    process.exit(1);
  }
}

function showHelp() {
  console.log('🔄 Semiont Service Restart Tool');
  console.log('');
  console.log('Usage: npx tsx restart.ts [frontend|backend|both]');
  console.log('   or: ./scripts/semiont restart [frontend|backend|both]');
  console.log('');
  console.log('Options:');
  console.log('   frontend  - Restart only the frontend service');
  console.log('   backend   - Restart only the backend service');
  console.log('   both      - Restart both services (default)');
  console.log('   (none)    - Restart both services');
  console.log('');
  console.log('Examples:');
  console.log('   ./scripts/semiont restart               # Restart both services');
  console.log('   ./scripts/semiont restart frontend      # Restart only frontend');
  console.log('   ./scripts/semiont restart backend       # Restart only backend');
  console.log('');
  console.log('When to restart:');
  console.log('   • After updating OAuth credentials (both services need new secrets)');
  console.log('   • After database schema changes (backend needs to reconnect)');
  console.log('   • When frontend/backend connectivity issues occur');
  console.log('   • After AWS Secrets Manager updates (services cache secrets)');
  console.log('   • When containers are stuck or unresponsive');
  console.log('   • To pick up new Docker images after deployment');
  console.log('');
  console.log('Service-specific scenarios:');
  console.log('   • Frontend only: NextAuth.js configuration changes');
  console.log('   • Backend only: Database connection issues, API problems');
  console.log('   • Both: OAuth setup, environment variable changes');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === '--help' || command === '-h' || command === 'help') {
    showHelp();
    return;
  }

  const targetService = command as 'frontend' | 'backend' | 'both' | undefined;
  
  // Validate service argument
  if (targetService && !['frontend', 'backend', 'both'].includes(targetService)) {
    console.error(`❌ Invalid service: ${targetService}`);
    console.log('💡 Valid options: frontend, backend, both');
    showHelp();
    process.exit(1);
  }

  await restartServices(targetService);
}

main().catch(console.error);