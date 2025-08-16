import { z } from 'zod';

// Environment configuration schema
export const EnvironmentConfigSchema = z.object({
  name: z.string(),
  region: z.string().optional(),
  awsAccountId: z.string().optional(),
  awsProfile: z.string().optional(),
  projectName: z.string().optional(),
  stackName: z.string().optional(),
  services: z.record(z.object({
    name: z.string(),
    type: z.enum(['container', 'fargate', 'lambda', 'ec2']),
    port: z.number().optional(),
    cpu: z.number().optional(),
    memory: z.number().optional(),
    desiredCount: z.number().optional(),
    minCount: z.number().optional(),
    maxCount: z.number().optional(),
    environment: z.record(z.string()).optional(),
    dockerfile: z.string().optional(),
    buildContext: z.string().optional(),
    image: z.string().optional(),
    command: z.array(z.string()).optional(),
    healthCheck: z.object({
      path: z.string().optional(),
      interval: z.number().optional(),
      timeout: z.number().optional(),
      retries: z.number().optional(),
    }).optional(),
  })).optional(),
  vpc: z.object({
    cidr: z.string().optional(),
    maxAzs: z.number().optional(),
  }).optional(),
  database: z.object({
    engine: z.string().optional(),
    instanceType: z.string().optional(),
    allocatedStorage: z.number().optional(),
    databaseName: z.string().optional(),
    port: z.number().optional(),
  }).optional(),
  monitoring: z.object({
    enabled: z.boolean().optional(),
    alertEmail: z.string().optional(),
  }).optional(),
  site: z.object({
    domain: z.string().optional(),
    subdomain: z.string().optional(),
    certificateArn: z.string().optional(),
    oauthAllowedDomains: z.array(z.string()).optional(),
  }).optional(),
  tags: z.record(z.string()).optional(),
});

export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;