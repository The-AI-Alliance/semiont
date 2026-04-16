import { describe, it, expect } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { createFilterVM } from '../filter';

describe('createFilterVM', () => {
  it('initializes with null', async () => {
    const vm = createFilterVM<string>();
    expect(await firstValueFrom(vm.selected$)).toBeNull();
    vm.dispose();
  });

  it('initializes with provided value', async () => {
    const vm = createFilterVM('Person');
    expect(await firstValueFrom(vm.selected$)).toBe('Person');
    vm.dispose();
  });

  it('select changes value', async () => {
    const vm = createFilterVM<string>();
    vm.select('Location');
    expect(await firstValueFrom(vm.selected$)).toBe('Location');
    vm.dispose();
  });

  it('clear resets to null', async () => {
    const vm = createFilterVM('Person');
    vm.clear();
    expect(await firstValueFrom(vm.selected$)).toBeNull();
    vm.dispose();
  });
});
