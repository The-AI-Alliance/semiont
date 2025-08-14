import { vi } from 'vitest';

export const existsSync = vi.fn();
export const writeFileSync = vi.fn();
export const mkdirSync = vi.fn();
export const readFileSync = vi.fn();
export const readdirSync = vi.fn();
export const statSync = vi.fn();
export const promises = {
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
};

export default {
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  promises,
};