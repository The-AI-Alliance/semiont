import * as fs from 'fs/promises';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ContainerProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printError, printWarning } from '../../../core/io/cli-logger.js';
import * as yaml from 'js-yaml';
import type { GraphServiceConfig } from '@semiont/core';
import { checkContainerRuntime, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Provision handler for graph database services using Docker
 * Currently supports JanusGraph
 */
const provisionGraphService = async (context: ContainerProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, runtime, containerName } = context;
  const serviceConfig = service.config as GraphServiceConfig;
  const graphType = serviceConfig.type;

  if (graphType !== 'janusgraph') {
    return {
      success: false,
      error: `Unsupported graph database for provisioning: ${graphType}`,
      metadata: { serviceType: 'graph', serviceName: graphType }
    };
  }

  if (!service.quiet) {
    printInfo('Provisioning JanusGraph using Docker...');
  }

  try {
    const storage = serviceConfig.storage;
    const index = serviceConfig.index;
    const withElasticsearch = index === 'elasticsearch';
    const withCassandra = storage === 'cassandra';
    const networkName = 'semiont-network';

    // Check if Docker is available
    try {
      execFileSync(runtime, ['--version'], { stdio: 'ignore' });
    } catch {
      return {
        success: false,
        error: 'Docker is required. Please install Docker.',
        metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
      };
    }

    // Create Docker network if it doesn't exist
    try {
      execFileSync(runtime, ['network', 'create', networkName], { stdio: 'ignore' });
    } catch {
      // Network might already exist
    }

    // Pull required images
    if (!service.quiet) {
      printInfo('Pulling required Docker images...');
    }

    try {
      execFileSync(runtime, ['pull', 'janusgraph/janusgraph:1.0.0'], {
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
    } catch (error) {
      printWarning('Failed to pull JanusGraph image, will try to use local');
    }

    if (withCassandra) {
      try {
        execFileSync(runtime, ['pull', 'cassandra:4'], {
          stdio: service.verbose ? 'inherit' : 'pipe'
        });
      } catch (error) {
        printWarning('Failed to pull Cassandra image, will try to use local');
      }
    }

    if (withElasticsearch) {
      try {
        execFileSync(runtime, ['pull', 'docker.elastic.co/elasticsearch/elasticsearch:7.17.10'], {
          stdio: service.verbose ? 'inherit' : 'pipe'
        });
      } catch (error) {
        printWarning('Failed to pull Elasticsearch image, will try to use local');
      }
    }

    // Generate docker-compose configuration
    const services: any = {
      janusgraph: {
        image: 'janusgraph/janusgraph:1.0.0',
        container_name: containerName,
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

      services.janusgraph.environment['janusgraph.storage.hostname'] = 'cassandra';
      services.janusgraph.environment['janusgraph.storage.cql.keyspace'] = 'janusgraph';
      services.janusgraph.depends_on = ['cassandra'];
    }

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

      services.janusgraph.environment['janusgraph.index.search.backend'] = 'elasticsearch';
      services.janusgraph.environment['janusgraph.index.search.hostname'] = 'elasticsearch';
      services.janusgraph.environment['janusgraph.index.search.elasticsearch.client-only'] = 'true';

      if (!services.janusgraph.depends_on) {
        services.janusgraph.depends_on = [];
      }
      services.janusgraph.depends_on.push('elasticsearch');
    }

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
      printSuccess('JanusGraph Docker stack provisioned successfully!');
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

const preflightGraphProvision = async (context: ContainerProvisionHandlerContext): Promise<PreflightResult> => {
  return preflightFromChecks([
    checkContainerRuntime(context.runtime),
  ]);
};

export const graphProvisionDescriptor: HandlerDescriptor<ContainerProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'container',
  serviceType: 'graph',
  handler: provisionGraphService,
  preflight: preflightGraphProvision
};
