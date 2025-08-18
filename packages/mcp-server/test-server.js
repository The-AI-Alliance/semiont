#!/usr/bin/env node

/**
 * Test script for Semiont MCP Server
 * 
 * This script starts the MCP server and tests the hello tool.
 * Run with: node test-server.js
 */

import { spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function testMCPServer() {
  console.log('Starting Semiont MCP Server test...\n');

  // Create transport for the MCP server
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: {
      ...process.env,
      SEMIONT_API_URL: process.env.SEMIONT_API_URL || 'http://localhost:4000',
      SEMIONT_API_TOKEN: process.env.SEMIONT_API_TOKEN || ''
    }
  });

  // Create MCP client
  const client = new Client({
    name: 'semiont-test-client',
    version: '1.0.0',
  }, {
    capabilities: {}
  });

  try {
    // Connect to the server
    await client.connect(transport);
    console.log('✅ Connected to MCP server\n');

    // List available tools
    const tools = await client.request({
      method: 'tools/list',
      params: {}
    });
    
    console.log('Available tools:');
    tools.tools.forEach(tool => {
      console.log(`  - ${tool.name}: ${tool.description}`);
    });
    console.log();

    // Test the hello tool without name
    console.log('Testing semiont_hello (no name):');
    const result1 = await client.request({
      method: 'tools/call',
      params: {
        name: 'semiont_hello',
        arguments: {}
      }
    });
    console.log(result1.content[0].text);
    console.log();

    // Test the hello tool with name
    console.log('Testing semiont_hello (with name):');
    const result2 = await client.request({
      method: 'tools/call',
      params: {
        name: 'semiont_hello',
        arguments: {
          name: 'MCP Test'
        }
      }
    });
    console.log(result2.content[0].text);
    console.log();

    console.log('✅ All tests passed!');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  } finally {
    // Close the connection
    await client.close();
    process.exit(0);
  }
}

// Run the test
testMCPServer().catch(console.error);