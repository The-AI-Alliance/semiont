import { describe, it, expect } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { createPaginationVM } from '../pagination';

describe('createPaginationVM', () => {
  it('initializes at page 0', async () => {
    const vm = createPaginationVM();
    expect(await firstValueFrom(vm.page$)).toBe(0);
    vm.dispose();
  });

  it('uses custom pageSize', async () => {
    const vm = createPaginationVM({ pageSize: 10 });
    expect(await firstValueFrom(vm.pageSize$)).toBe(10);
    vm.dispose();
  });

  it('setPage changes page', async () => {
    const vm = createPaginationVM();
    vm.setPage(3);
    expect(await firstValueFrom(vm.page$)).toBe(3);
    vm.dispose();
  });

  it('setPage clamps to 0', async () => {
    const vm = createPaginationVM();
    vm.setPage(-5);
    expect(await firstValueFrom(vm.page$)).toBe(0);
    vm.dispose();
  });

  it('nextPage and prevPage', async () => {
    const vm = createPaginationVM();
    vm.nextPage();
    expect(await firstValueFrom(vm.page$)).toBe(1);
    vm.nextPage();
    expect(await firstValueFrom(vm.page$)).toBe(2);
    vm.prevPage();
    expect(await firstValueFrom(vm.page$)).toBe(1);
    vm.dispose();
  });

  it('prevPage does not go below 0', async () => {
    const vm = createPaginationVM();
    vm.prevPage();
    expect(await firstValueFrom(vm.page$)).toBe(0);
    vm.dispose();
  });

  it('computes totalPages from totalItems and pageSize', async () => {
    const vm = createPaginationVM({ pageSize: 10 });
    vm.setTotalItems(25);
    expect(await firstValueFrom(vm.totalPages$)).toBe(3);
    vm.dispose();
  });

  it('hasNext and hasPrev', async () => {
    const vm = createPaginationVM({ pageSize: 10 });
    vm.setTotalItems(25);
    expect(await firstValueFrom(vm.hasPrev$)).toBe(false);
    expect(await firstValueFrom(vm.hasNext$)).toBe(true);
    vm.setPage(2);
    expect(await firstValueFrom(vm.hasPrev$)).toBe(true);
    expect(await firstValueFrom(vm.hasNext$)).toBe(false);
    vm.dispose();
  });
});
