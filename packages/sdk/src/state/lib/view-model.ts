import { Subscription } from 'rxjs';

export interface ViewModel {
  dispose(): void;
}

export function createDisposer(): {
  add(vm: ViewModel | (() => void)): void;
  dispose(): void;
} {
  const sub = new Subscription();
  return {
    add: (item) =>
      sub.add(typeof item === 'function' ? item : () => item.dispose()),
    dispose: () => sub.unsubscribe(),
  };
}
