import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { createFormVM } from '../form';

describe('createFormVM', () => {
  it('initializes with provided values', async () => {
    const vm = createFormVM({ name: '', email: '' });
    expect(await firstValueFrom(vm.values$)).toEqual({ name: '', email: '' });
    expect(await firstValueFrom(vm.isDirty$)).toBe(false);
    vm.dispose();
  });

  it('setValue updates a single field', async () => {
    const vm = createFormVM({ name: '', age: 0 });
    vm.setValue('name', 'Alice');
    const values = await firstValueFrom(vm.values$);
    expect(values.name).toBe('Alice');
    expect(values.age).toBe(0);
    vm.dispose();
  });

  it('setValues updates multiple fields', async () => {
    const vm = createFormVM({ name: '', age: 0 });
    vm.setValues({ name: 'Bob', age: 30 });
    expect(await firstValueFrom(vm.values$)).toEqual({ name: 'Bob', age: 30 });
    vm.dispose();
  });

  it('isDirty$ is true when values differ from initial', async () => {
    const vm = createFormVM({ name: '' });
    vm.setValue('name', 'changed');
    expect(await firstValueFrom(vm.isDirty$)).toBe(true);
    vm.dispose();
  });

  it('reset restores initial values and clears errors', async () => {
    const vm = createFormVM({ name: '' }, (v) => v.name ? {} : { name: 'required' });
    vm.setValue('name', 'x');
    vm.reset();
    expect(await firstValueFrom(vm.values$)).toEqual({ name: '' });
    expect(await firstValueFrom(vm.errors$)).toEqual({});
    expect(await firstValueFrom(vm.isDirty$)).toBe(false);
    vm.dispose();
  });

  it('runs validation on setValue', async () => {
    const vm = createFormVM({ name: '' }, (v) => v.name ? {} : { name: 'required' });
    expect(await firstValueFrom(vm.errors$)).toEqual({});
    vm.setValue('name', '');
    expect(await firstValueFrom(vm.errors$)).toEqual({ name: 'required' });
    vm.setValue('name', 'valid');
    expect(await firstValueFrom(vm.errors$)).toEqual({});
    vm.dispose();
  });

  it('submit calls handler when valid', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const vm = createFormVM({ name: 'ok' });
    await vm.submit(handler);
    expect(handler).toHaveBeenCalledWith({ name: 'ok' });
    vm.dispose();
  });

  it('submit does not call handler when errors exist', async () => {
    const handler = vi.fn();
    const vm = createFormVM({ name: '' }, (v) => v.name ? {} : { name: 'required' });
    await vm.submit(handler);
    expect(handler).not.toHaveBeenCalled();
    vm.dispose();
  });

  it('isSubmitting$ tracks async submission', async () => {
    let resolveSubmit: () => void;
    const handler = vi.fn(() => new Promise<void>((r) => { resolveSubmit = r; }));
    const vm = createFormVM({ name: 'ok' });

    const submitPromise = vm.submit(handler);
    expect(await firstValueFrom(vm.isSubmitting$)).toBe(true);

    resolveSubmit!();
    await submitPromise;
    expect(await firstValueFrom(vm.isSubmitting$)).toBe(false);

    vm.dispose();
  });
});
