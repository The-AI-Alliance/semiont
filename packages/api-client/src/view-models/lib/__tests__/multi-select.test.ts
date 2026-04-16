import { describe, it, expect } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { createMultiSelectVM } from '../multi-select';

describe('createMultiSelectVM', () => {
  it('initializes empty', async () => {
    const vm = createMultiSelectVM<string>();
    const selected = await firstValueFrom(vm.selected$);
    expect(selected.size).toBe(0);
    expect(await firstValueFrom(vm.count$)).toBe(0);
    vm.dispose();
  });

  it('toggle adds and removes', async () => {
    const vm = createMultiSelectVM<string>();
    vm.toggle('a');
    expect((await firstValueFrom(vm.selected$)).has('a')).toBe(true);
    vm.toggle('a');
    expect((await firstValueFrom(vm.selected$)).has('a')).toBe(false);
    vm.dispose();
  });

  it('select and deselect', async () => {
    const vm = createMultiSelectVM<string>();
    vm.select('x');
    vm.select('y');
    expect(await firstValueFrom(vm.count$)).toBe(2);
    vm.deselect('x');
    expect(await firstValueFrom(vm.count$)).toBe(1);
    expect(vm.isSelected('y')).toBe(true);
    expect(vm.isSelected('x')).toBe(false);
    vm.dispose();
  });

  it('selectAll replaces selection', async () => {
    const vm = createMultiSelectVM<string>();
    vm.select('old');
    vm.selectAll(['a', 'b', 'c']);
    expect(await firstValueFrom(vm.count$)).toBe(3);
    expect(vm.isSelected('old')).toBe(false);
    vm.dispose();
  });

  it('clear empties selection', async () => {
    const vm = createMultiSelectVM<string>();
    vm.selectAll(['a', 'b']);
    vm.clear();
    expect(await firstValueFrom(vm.count$)).toBe(0);
    vm.dispose();
  });
});
