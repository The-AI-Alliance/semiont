/** @type {import('next').NextConfig} */

import nextIntl from 'next-intl/plugin';
import bundleAnalyzer from '@next/bundle-analyzer';

const withNextIntl = nextIntl('./src/i18n.ts');

// Only load bundle analyzer when explicitly analyzing
const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

// Security headers configuration
const securityHeaders = [
  // Content Security Policy
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://accounts.google.com https://apis.google.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https: blob:",
      // Allow connections to self (routing layer routes to backend), Google OAuth
      "connect-src 'self' https://accounts.google.com https://www.googleapis.com",
      "frame-src 'self' https://accounts.google.com",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      // Upgrade to HTTPS except in development
      ...(process.env.NODE_ENV !== 'development' ? ["upgrade-insecure-requests"] : []),
    ].join('; '),
  },
  // Prevent clickjacking
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  // Prevent MIME type sniffing
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  // Referrer policy
  {
    key: 'Referrer-Policy',
    value: 'origin-when-cross-origin',
  },
  // Permissions policy (restrict browser features)
  {
    key: 'Permissions-Policy',
    value: [
      'camera=()',
      'microphone=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'payment=()',
      'usb=()',
    ].join(', '),
  },
  // Cross-Origin policies
  {
    key: 'Cross-Origin-Opener-Policy',
    value: 'same-origin',
  },
  {
    key: 'Cross-Origin-Resource-Policy',
    value: 'same-origin',
  },
  // Force HTTPS in production
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains; preload',
  },
];

const baseConfig = {
  // Enable standalone output for container deployment
  output: 'standalone',

  // Transpile workspace packages for proper ESM handling with dynamic imports
  transpilePackages: ['@semiont/react-ui'],

  // Security headers
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },

  // Image optimization domains
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        pathname: '/a/**',
      },
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
        pathname: '/**',
      },
    ],
    // Image optimization settings
    formats: ['image/webp', 'image/avif'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 60 * 60 * 24 * 7, // 7 days
    // Security: Disable external image loading unless explicitly allowed
    dangerouslyAllowSVG: false,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;"
  },

  // Strict mode for development
  reactStrictMode: true,

  // Performance optimizations
  compress: true,
  poweredByHeader: false,

  experimental: {
    // Enable if needed for future features
    // optimizeCss: true, // Disabled due to critters dependency issue
    optimizePackageImports: [
      '@tanstack/react-query',
      'next-auth',
      '@heroicons/react',
      '@headlessui/react',
      '@codemirror/lang-json',
      '@codemirror/lang-markdown',
      '@codemirror/view',
      'react-markdown',
    ],
    serverActions: {
      // Allow Server Actions from forwarded hosts (proxy, load balancer, etc.)
      // NEXT_PUBLIC_ALLOWED_ORIGINS: comma-separated list of allowed origin patterns
      allowedOrigins: process.env.NEXT_PUBLIC_ALLOWED_ORIGINS?.split(',').map(s => s.trim()) || [],
    },
  },

  // Bundle optimization
  webpack: (config, { dev, isServer }) => {
    // Prevent errors during build-time route analysis
    if (isServer) {
      config.optimization = config.optimization || {};
      config.optimization.minimize = false;
    }

    // Bundle size optimizations
    if (!dev && !isServer) {
      config.optimization.splitChunks = {
        ...config.optimization.splitChunks,
        cacheGroups: {
          ...config.optimization.splitChunks.cacheGroups,
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            chunks: 'all',
            enforce: true,
          },
          common: {
            name: 'common',
            minChunks: 2,
            chunks: 'all',
            enforce: true,
          },
        },
      };
    }

    return config;
  },

  // TypeScript configuration
  typescript: {
    // Fail build on TypeScript errors
    ignoreBuildErrors: false,
  },

  // ESLint configuration
  eslint: {
    // Fail build on ESLint errors
    ignoreDuringBuilds: false,
  },
};

// Export configuration with bundle analyzer and next-intl
export default withNextIntl(withBundleAnalyzer(baseConfig));
