#!/usr/bin/env node

const { spawn } = require('child_process');
const { createServer } = require('http');

// Simple mock API server
const mockServer = createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  // Mock responses
  const responses = {
    '/api/health': { status: 'ok', timestamp: new Date().toISOString() },
    '/api/auth/session': { user: null }, // Not logged in by default
    '/api/admin/stats': { users: 42, sessions: 17 },
    '/api/admin/users': {
      users: [
        { id: 1, email: 'admin@example.com', name: 'Admin User', role: 'admin' },
        { id: 2, email: 'user@example.com', name: 'Regular User', role: 'user' }
      ]
    }
  };

  const response = responses[req.url] || { error: 'Not found' };
  res.statusCode = responses[req.url] ? 200 : 404;
  res.end(JSON.stringify(response));
});

// Start mock server
mockServer.listen(4000, () => {
  console.log('🚀 Mock API server running on http://localhost:4000');
  
  // Start Next.js dev server
  const nextDev = spawn('npm', ['run', 'dev'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, NEXT_PUBLIC_API_URL: 'http://localhost:4000' }
  });

  // Handle exit
  process.on('SIGINT', () => {
    console.log('\n⏹️  Shutting down...');
    nextDev.kill();
    mockServer.close();
    process.exit();
  });
});