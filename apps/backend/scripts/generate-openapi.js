#!/usr/bin/env node
/**
 * Generate OpenAPI specification from running backend
 *
 * This script:
 * 1. Starts the backend server temporarily
 * 2. Fetches the OpenAPI spec from /api/openapi.json
 * 3. Saves it to public/openapi.json
 * 4. Copies it to packages/api-client/openapi.json
 * 5. Shuts down the server
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.PORT || 4000;
const HOST = 'localhost';
const BACKEND_URL = `http://${HOST}:${PORT}`;
const OPENAPI_URL = `${BACKEND_URL}/api/openapi.json`;

const PUBLIC_DIR = path.join(__dirname, '../public');
const PUBLIC_SPEC_PATH = path.join(PUBLIC_DIR, 'openapi.json');
const API_CLIENT_SPEC_PATH = path.join(__dirname, '../../../packages/api-client/openapi.json');

async function fetchWithRetry(url, maxRetries = 10, delay = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      if (response.status === 404 || response.status === 500) {
        console.log(`Attempt ${i + 1}/${maxRetries}: Server not ready yet (${response.status})`);
      }
    } catch (error) {
      console.log(`Attempt ${i + 1}/${maxRetries}: Connection failed - ${error.message}`);
    }

    if (i < maxRetries - 1) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts`);
}

async function generateOpenAPI() {
  console.log('🔄 Generating OpenAPI specification...\n');

  // Ensure public directory exists
  if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  }

  // Start the backend server
  console.log(`📦 Starting backend server on ${BACKEND_URL}...`);
  const serverProcess = spawn('node', ['dist/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: PORT.toString(),
      NODE_ENV: 'production',
      CORS_ORIGIN: 'http://localhost:3000',
      FRONTEND_URL: 'http://localhost:3000',
      BACKEND_URL: `http://localhost:${PORT}`,
      DATA_DIR: '/tmp/semiont-openapi-gen',
      // Skip database connections for OpenAPI generation
      SKIP_DB_CONNECTION: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverReady = false;
  let serverFailed = false;

  // Wait for server to be ready
  serverProcess.stdout.on('data', (data) => {
    const output = data.toString();
    if (output.includes('listening on')) {
      serverReady = true;
    }
  });

  serverProcess.stderr.on('data', (data) => {
    // Show all stderr during startup to debug issues
    const output = data.toString();
    console.error(output);
  });

  // Handle server process exit
  serverProcess.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      serverFailed = true;
      console.error(`\n❌ Backend server exited with code ${code}`);
    }
  });

  serverProcess.on('error', (error) => {
    serverFailed = true;
    console.error(`\n❌ Failed to start backend server:`, error);
  });

  try {
    // Wait a bit for server to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if server failed to start
    if (serverFailed) {
      throw new Error('Backend server failed to start - check if port is already in use');
    }

    // Fetch the OpenAPI spec
    console.log(`📥 Fetching OpenAPI spec from ${OPENAPI_URL}...`);
    const response = await fetchWithRetry(OPENAPI_URL);
    const spec = await response.json();

    // Save to public directory
    fs.writeFileSync(PUBLIC_SPEC_PATH, JSON.stringify(spec, null, 2));
    console.log(`✅ OpenAPI spec saved to: ${PUBLIC_SPEC_PATH}`);

    // Copy to api-client package
    const apiClientDir = path.dirname(API_CLIENT_SPEC_PATH);
    if (!fs.existsSync(apiClientDir)) {
      fs.mkdirSync(apiClientDir, { recursive: true });
    }
    fs.copyFileSync(PUBLIC_SPEC_PATH, API_CLIENT_SPEC_PATH);
    console.log(`✅ OpenAPI spec copied to: ${API_CLIENT_SPEC_PATH}`);

    console.log('\n✨ OpenAPI generation complete!');
  } catch (error) {
    console.error('\n❌ OpenAPI generation failed:', error.message);
    throw error; // Re-throw to ensure cleanup happens and we exit with error
  } finally {
    // Kill the server process and wait for it to die
    if (serverProcess && !serverProcess.killed) {
      console.log('\n🛑 Shutting down backend server...');

      await new Promise((resolve) => {
        serverProcess.on('exit', () => {
          console.log('✅ Backend server stopped');
          resolve();
        });

        serverProcess.kill('SIGTERM');

        // Force kill after 2 seconds if it doesn't exit gracefully
        setTimeout(() => {
          if (!serverProcess.killed) {
            console.log('⚠️  Force killing backend server...');
            serverProcess.kill('SIGKILL');
          }
        }, 2000);
      });
    }
  }
}

// Handle script termination
process.on('SIGINT', () => {
  console.log('\n⚠️  Script interrupted');
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('\n⚠️  Script terminated');
  process.exit(1);
});

generateOpenAPI();
