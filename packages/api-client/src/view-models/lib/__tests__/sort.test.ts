import { describe, it, expect } from 'vitest';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { createSortVM } from '../sort';

describe('createSortVM', () => {
  it('initializes with provided key and direction', async () => {
    const vm = createSortVM('name', 'asc');
    expect(await firstValueFrom(vm.key$)).toBe('name');
    expect(await firstValueFrom(vm.direction$)).toBe('asc');
    vm.dispose();
  });

  it('setSort changes key and direction', async () => {
    const vm = createSortVM('name');
    vm.setSort('date', 'desc');
    expect(await firstValueFrom(vm.key$)).toBe('date');
    expect(await firstValueFrom(vm.direction$)).toBe('desc');
    vm.dispose();
  });

  it('toggleDirection flips between asc and desc', async () => {
    const vm = createSortVM('name', 'asc');
    vm.toggleDirection();
    expect(await firstValueFrom(vm.direction$)).toBe('desc');
    vm.toggleDirection();
    expect(await firstValueFrom(vm.direction$)).toBe('asc');
    vm.dispose();
  });

  it('sortedItems$ sorts by comparator and direction', async () => {
    const items$ = new BehaviorSubject([{ n: 'C' }, { n: 'A' }, { n: 'B' }]);
    const vm = createSortVM<'name'>('name', 'asc');

    const sorted = vm.sortedItems$(items$, {
      name: (a, b) => a.n.localeCompare(b.n),
    });

    const asc = await firstValueFrom(sorted);
    expect(asc.map((i) => i.n)).toEqual(['A', 'B', 'C']);

    vm.toggleDirection();
    const desc = await firstValueFrom(sorted);
    expect(desc.map((i) => i.n)).toEqual(['C', 'B', 'A']);

    vm.dispose();
  });
});
