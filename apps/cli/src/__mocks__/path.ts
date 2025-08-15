import { vi } from 'vitest';

export const join = vi.fn((...args: string[]) => args.join('/'));
export const basename = vi.fn((p: string) => p.split('/').pop() || 'project');
export const dirname = vi.fn((p: string) => {
  const parts = p.split('/');
  parts.pop();
  return parts.join('/');
});
export const resolve = vi.fn((...args: string[]) => args.join('/'));

export default {
  join,
  basename,
  dirname,
  resolve,
};