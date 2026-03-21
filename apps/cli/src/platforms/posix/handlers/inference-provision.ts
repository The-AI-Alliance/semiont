import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { getInferencePaths } from './inference-paths.js';
import { InferenceService } from '../../../services/inference-service.js';
import { checkCommandAvailable, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult, PreflightCheck } from '../../../core/handlers/types.js';

const provisionInference = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service } = context;
  const models = (service as InferenceService).getModels();

  if (models.length === 0) {
    return {
      success: false,
      error: 'No models configured for ollama inference provider',
      metadata: { serviceType: 'inference' }
    };
  }

  const paths = getInferencePaths(context);

  // Create runtime directories
  fs.mkdirSync(paths.logsDir, { recursive: true });

  const pulledModels: string[] = [];

  for (const model of models) {
    if (!service.quiet) {
      printInfo(`Pulling model ${model}...`);
    }

    try {
      execFileSync('ollama', ['pull', model], {
        stdio: service.quiet ? 'ignore' : 'inherit',
      });
      pulledModels.push(model);
    } catch (error) {
      return {
        success: false,
        error: `Failed to pull model ${model}: ${error}`,
        metadata: { serviceType: 'inference', model }
      };
    }

    if (!service.quiet) {
      printSuccess(`Model ${model} pulled successfully`);
    }
  }

  return {
    success: true,
    resources: {
      platform: 'posix',
      data: { path: paths.runtimeDir }
    },
    metadata: {
      serviceType: 'inference',
      models: pulledModels,
    }
  };
};

function detectGpu(): PreflightCheck {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS — check for Apple Silicon (Metal always available)
    try {
      const brand = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], {
        encoding: 'utf-8',
      }).trim();

      if (brand.includes('Apple')) {
        return { name: 'GPU detection', pass: true, message: `Apple Silicon detected (${brand}) — Metal acceleration available` };
      }
      return { name: 'GPU detection', pass: true, message: `Intel Mac detected — CPU-only inference` };
    } catch {
      return { name: 'GPU detection', pass: true, message: 'Could not detect CPU type — Ollama will auto-detect acceleration' };
    }
  }

  // Linux — check NVIDIA
  try {
    const gpuName = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (gpuName) {
      return { name: 'GPU detection', pass: true, message: `NVIDIA GPU detected: ${gpuName}` };
    }
  } catch {
    // No NVIDIA GPU
  }

  // Linux — check ROCm
  try {
    const output = execFileSync('rocm-smi', ['--showproductname'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (output) {
      return { name: 'GPU detection', pass: true, message: `AMD ROCm GPU detected` };
    }
  } catch {
    // No ROCm GPU
  }

  return { name: 'GPU detection', pass: true, message: 'No GPU detected — CPU-only inference' };
}

const preflightInferenceProvision = async (_context: PosixProvisionHandlerContext): Promise<PreflightResult> => {
  return preflightFromChecks([
    checkCommandAvailable('ollama'),
    detectGpu(),
  ]);
};

export const inferenceProvisionDescriptor: HandlerDescriptor<PosixProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'posix',
  serviceType: 'inference',
  handler: provisionInference,
  preflight: preflightInferenceProvision,
};
