import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';
import { ContainerProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printError, printWarning } from '../../../core/io/cli-logger.js';
import * as yaml from 'js-yaml';

/**
 * Provision handler for graph database services using Docker
 * Currently supports JanusGraph
 */
const provisionGraphService = async (context: ContainerProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service } = context;
  
  // Determine which graph database to provision from service config
  const graphType = service.config.type;
  
  if (graphType !== 'janusgraph') {
    return {
      success: false,
      error: `Unsupported graph database for provisioning: ${graphType}`,
      metadata: { serviceType: 'graph', serviceName: graphType }
    };
  }
  
  if (!service.quiet) {
    printInfo('🐳 Provisioning JanusGraph using Docker...');
  }
    
  try {
    // Read configuration from service config
    const storage = service.config.storage || 'cassandra';
    const index = service.config.index || 'elasticsearch';
    const withElasticsearch = index === 'elasticsearch';
    const withCassandra = storage === 'cassandra';
    const networkName = 'semiont-network';
      
    // Check if Docker is available
    try {
      execSync('docker --version', { stdio: 'ignore' });
    } catch {
      return {
        success: false,
        error: 'Docker is required. Please install Docker.',
        metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
      };
    }
      
      // Create Docker network if it doesn't exist
      try {
        execSync(`docker network create ${networkName}`, { stdio: 'ignore' });
      } catch {
        // Network might already exist, that's fine
      }
      
      // Pull required images
      if (!service.quiet) {
        printInfo('Pulling required Docker images...');
      }
      
      // Pull JanusGraph image
      try {
        execSync('docker pull janusgraph/janusgraph:1.0.0', {
          stdio: service.verbose ? 'inherit' : 'pipe'
        });
      } catch (error) {
        printWarning('Failed to pull JanusGraph image, will try to use local');
      }
      
      // Pull Cassandra if requested
      if (withCassandra) {
        try {
          execSync('docker pull cassandra:4', {
            stdio: service.verbose ? 'inherit' : 'pipe'
          });
        } catch (error) {
          printWarning('Failed to pull Cassandra image, will try to use local');
        }
      }
      
      // Pull Elasticsearch if requested
      if (withElasticsearch) {
        try {
          execSync('docker pull docker.elastic.co/elasticsearch/elasticsearch:7.17.10', {
            stdio: service.verbose ? 'inherit' : 'pipe'
          });
        } catch (error) {
          printWarning('Failed to pull Elasticsearch image, will try to use local');
        }
      }
      
      // Generate docker-compose configuration
      const containerName = `semiont-${service.name}-${service.environment}`;
      const services: any = {
        janusgraph: {
          image: 'janusgraph/janusgraph:1.0.0',
          container_name: containerName,
          // Note: Not setting user field to allow JanusGraph's entrypoint to run as root initially
          // This generates chown warnings on macOS but allows proper initialization
          networks: [networkName],
          ports: ['8182:8182'],
          environment: {
            JAVA_OPTIONS: '-Xms1g -Xmx2g',
            'janusgraph.storage.backend': withCassandra ? 'cql' : 'berkeleyje',
            'janusgraph.storage.directory': '/var/lib/janusgraph/data',
          },
          volumes: [
            'janusgraph-data:/var/lib/janusgraph/data',
          ],
        },
      };
      
      // Add Cassandra if requested
      if (withCassandra) {
        services.cassandra = {
          image: 'cassandra:4',
          container_name: 'semiont-cassandra',
          networks: [networkName],
          ports: ['9042:9042'],
          environment: {
            CASSANDRA_CLUSTER_NAME: 'JanusGraph',
            CASSANDRA_DC: 'datacenter1',
            CASSANDRA_ENDPOINT_SNITCH: 'GossipingPropertyFileSnitch',
          },
          volumes: [
            'cassandra-data:/var/lib/cassandra',
          ],
        };
        
        // Update JanusGraph to use Cassandra
        services.janusgraph.environment['janusgraph.storage.hostname'] = 'cassandra';
        services.janusgraph.environment['janusgraph.storage.cql.keyspace'] = 'janusgraph';
        services.janusgraph.depends_on = ['cassandra'];
      }
      
      // Add Elasticsearch if requested
      if (withElasticsearch) {
        services.elasticsearch = {
          image: 'docker.elastic.co/elasticsearch/elasticsearch:7.17.10',
          container_name: 'semiont-elasticsearch',
          networks: [networkName],
          ports: ['9200:9200', '9300:9300'],
          environment: {
            'discovery.type': 'single-node',
            'ES_JAVA_OPTS': '-Xms512m -Xmx512m',
            'xpack.security.enabled': 'false',
          },
          volumes: [
            'elasticsearch-data:/usr/share/elasticsearch/data',
          ],
        };
        
        // Update JanusGraph to use Elasticsearch
        services.janusgraph.environment['janusgraph.index.search.backend'] = 'elasticsearch';
        services.janusgraph.environment['janusgraph.index.search.hostname'] = 'elasticsearch';
        services.janusgraph.environment['janusgraph.index.search.elasticsearch.client-only'] = 'true';
        
        if (!services.janusgraph.depends_on) {
          services.janusgraph.depends_on = [];
        }
        services.janusgraph.depends_on.push('elasticsearch');
      }
      
      // Create docker-compose.yml
      const dockerCompose = {
        version: '3.8',
        services,
        networks: {
          [networkName]: {
            external: true,
          },
        },
        volumes: {
          'janusgraph-data': {},
          ...(withCassandra && { 'cassandra-data': {} }),
          ...(withElasticsearch && { 'elasticsearch-data': {} }),
        },
      };
      
    const composePath = path.join(service.projectRoot, 'docker-compose.janusgraph.yml');
    await fs.writeFile(
      composePath,
      `# Generated by semiont provision --service janusgraph\n` +
      yaml.dump(dockerCompose)
    );
      
    if (!service.quiet) {
      printSuccess('✅ JanusGraph Docker stack provisioned successfully!');
      printInfo('');
      printInfo('Images pulled:');
      printInfo('  JanusGraph: janusgraph/janusgraph:1.0.0');
      if (withCassandra) printInfo('  Cassandra: cassandra:4');
      if (withElasticsearch) printInfo('  Elasticsearch: docker.elastic.co/elasticsearch/elasticsearch:7.17.10');
      printInfo('');
      printInfo('Configuration:');
      printInfo(`  Storage backend: ${storage}`);
      printInfo(`  Index backend: ${index}`);
      printInfo(`  Docker Compose: ${composePath}`);
      printInfo('');
      printInfo('To start JanusGraph:');
      printInfo('  semiont start --service graph --environment local');
      printInfo('');
      printInfo('Service URLs (after starting):');
      printInfo('  Gremlin Server: ws://localhost:8182/gremlin');
      if (withCassandra) printInfo('  Cassandra: localhost:9042');
      if (withElasticsearch) printInfo('  Elasticsearch: http://localhost:9200');
    }
    
    return {
      success: true,
      metadata: {
        serviceType: 'graph',
        serviceName: 'janusgraph',
        composePath,
        storage: storage,
        index: index,
        urls: {
          gremlin: 'ws://localhost:8182/gremlin',
          ...(withCassandra && { cassandra: 'localhost:9042' }),
          ...(withElasticsearch && { elasticsearch: 'http://localhost:9200' })
        }
      }
    };
    
  } catch (error) {
    if (!service.quiet) {
      printError(`Failed to provision JanusGraph: ${error}`);
    }
    return {
      success: false,
      error: `Failed to provision JanusGraph: ${error}`,
      metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
    };
  }
};

/**
 * Handler descriptor for graph database provisioning
 */
export const graphProvisionDescriptor: HandlerDescriptor<ContainerProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'container',
  serviceType: 'graph',
  handler: provisionGraphService
};