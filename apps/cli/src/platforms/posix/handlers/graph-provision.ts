import * as fs from 'fs/promises';
import { execSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printError } from '../../../core/io/cli-logger.js';
import { getGraphPaths } from './graph-paths.js';
import type { GraphServiceConfig } from '@semiont/core';

/**
 * Provision handler for graph database services on POSIX systems
 * Currently supports JanusGraph
 */
const provisionGraphService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, options } = context;
  const args = options.args;

  // Type narrowing for graph service config
  const serviceConfig = service.config as GraphServiceConfig;

  // Determine which graph database to provision from service config
  const graphType = serviceConfig.type;
  
  if (graphType !== 'janusgraph') {
    return {
      success: false,
      error: `Unsupported graph database for provisioning: ${graphType}`,
      metadata: { serviceType: 'graph', serviceName: graphType }
    };
  }
  
  if (!service.quiet) {
    printInfo('🔧 Provisioning JanusGraph for posix platform...');
  }
    
  try {
    // Parse options from args
    const withElasticsearch = args.includes('--with-elasticsearch');
    const withCassandra = args.includes('--with-cassandra');

    // Get graph paths
    const paths = getGraphPaths(context);
    const {
      dataDir,
      janusgraphDir,
      janusgraphZipPath: zipPath,
      configPath,
      graphConfigPath: graphConfig,
      dataStorageDir
    } = paths;
      
    // Check if Java is installed (required for JanusGraph)
    try {
      execSync('java -version', { stdio: 'ignore' });
    } catch {
      return {
        success: false,
        error: 'Java is required for JanusGraph. Please install Java 8 or 11.',
        metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
      };
    }
      
      // Create data directory
      await fs.mkdir(dataDir, { recursive: true });

      // Download JanusGraph if not present
      const janusgraphVersion = serviceConfig.janusgraphVersion;
      const downloadUrl = `https://github.com/JanusGraph/janusgraph/releases/download/v${janusgraphVersion}/janusgraph-${janusgraphVersion}.zip`;

      if (!await fileExists(janusgraphDir)) {
        console.log(`Downloading JanusGraph ${janusgraphVersion}...`);
        
        // Download the zip file
        execSync(`curl -L -o "${zipPath}" "${downloadUrl}"`, { stdio: 'inherit' });
        
        // Extract the zip file
        console.log('Extracting JanusGraph...');
        execSync(`unzip -q "${zipPath}" -d "${dataDir}"`, { stdio: 'inherit' });
        
        // Clean up zip file
        await fs.unlink(zipPath);
      }
      
      // Create graph configuration
      let graphProperties = `
# JanusGraph configuration
gremlin.graph=org.janusgraph.core.JanusGraphFactory
      `.trim();
      
      if (withCassandra) {
        graphProperties += `
# Cassandra storage backend
storage.backend=cql
storage.hostname=localhost
storage.cql.keyspace=janusgraph
`;
      } else {
        // Default to BerkeleyDB for simplicity
        graphProperties += `
# BerkeleyDB storage backend (embedded)
storage.backend=berkeleyje
storage.directory=${dataStorageDir}
`;
      }
      
      if (withElasticsearch) {
        graphProperties += `
# Elasticsearch index backend
index.search.backend=elasticsearch
index.search.hostname=localhost
index.search.elasticsearch.client-only=true
`;
      }
      
      await fs.writeFile(graphConfig, graphProperties);
      
      // Create server configuration
      const serverConfig = `
host: 0.0.0.0
port: 8182
evaluationTimeout: 30000
channelizer: org.apache.tinkerpop.gremlin.server.channel.WebSocketChannelizer
graphs: {
  graph: ${graphConfig}
}
scriptEngines: {
  gremlin-groovy: {
    plugins: { org.janusgraph.graphdb.tinkerpop.plugin.JanusGraphGremlinPlugin: {},
               org.apache.tinkerpop.gremlin.server.jsr223.GremlinServerGremlinPlugin: {},
               org.apache.tinkerpop.gremlin.tinkergraph.jsr223.TinkerGraphGremlinPlugin: {},
               org.apache.tinkerpop.gremlin.jsr223.ImportGremlinPlugin: {classImports: [java.lang.Math], methodImports: [java.lang.Math#*]},
               org.apache.tinkerpop.gremlin.jsr223.ScriptFileGremlinPlugin: {files: [scripts/empty-sample.groovy]}}}}
serializers:
  - { className: org.apache.tinkerpop.gremlin.driver.ser.GraphBinaryMessageSerializerV1 }
  - { className: org.apache.tinkerpop.gremlin.driver.ser.GraphSONMessageSerializerV3d0, config: { ioRegistries: [org.janusgraph.graphdb.tinkerpop.JanusGraphIoRegistry] }}
processors:
  - { className: org.apache.tinkerpop.gremlin.server.op.session.SessionOpProcessor, config: { sessionTimeout: 28800000 }}
  - { className: org.apache.tinkerpop.gremlin.server.op.traversal.TraversalOpProcessor }
metrics: {
  consoleReporter: {enabled: false, interval: 180000},
  csvReporter: {enabled: false, interval: 180000, fileName: /tmp/gremlin-server-metrics.csv},
  jmxReporter: {enabled: false},
  slf4jReporter: {enabled: false, interval: 180000}
}
strictTransactionManagement: false
idleConnectionTimeout: 0
keepAliveInterval: 0
maxInitialLineLength: 4096
maxHeaderSize: 8192
maxChunkSize: 8192
maxContentLength: 10485760
maxAccumulationBufferComponents: 1024
resultIterationBatchSize: 64
writeBufferLowWaterMark: 32768
writeBufferHighWaterMark: 65536
ssl: {
  enabled: false
}
`;
      
      await fs.writeFile(configPath, serverConfig);
      
    if (!service.quiet) {
      printSuccess('✅ JanusGraph provisioned successfully!');
      printInfo(`Data directory: ${dataDir}`);
      printInfo(`Storage backend: ${withCassandra ? 'Cassandra' : 'BerkeleyDB'}`);
      printInfo(`Index backend: ${withElasticsearch ? 'Elasticsearch' : 'None'}`);
      printInfo('');
      printInfo('To start JanusGraph:');
      printInfo('  semiont start --service janusgraph');
    }
    
    return {
      success: true,
      metadata: {
        serviceType: 'graph',
        serviceName: 'janusgraph',
        dataDir,
        configPath,
        graphConfig,
        storage: withCassandra ? 'cassandra' : 'berkeleydb',
        index: withElasticsearch ? 'elasticsearch' : 'none'
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handler descriptor for graph database provisioning
 */
export const graphProvisionDescriptor: HandlerDescriptor<PosixProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'posix',
  serviceType: 'graph',
  handler: provisionGraphService
};