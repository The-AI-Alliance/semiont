import { BehaviorSubject, type Observable, map } from 'rxjs';
import type { ViewModel } from './view-model';

export interface FormVM<T extends Record<string, unknown>> extends ViewModel {
  values$: Observable<T>;
  errors$: Observable<Partial<Record<keyof T, string>>>;
  isDirty$: Observable<boolean>;
  isSubmitting$: Observable<boolean>;
  setValue<K extends keyof T>(key: K, value: T[K]): void;
  setValues(partial: Partial<T>): void;
  reset(): void;
  submit(handler: (values: T) => Promise<void>): Promise<void>;
}

export function createFormVM<T extends Record<string, unknown>>(
  initial: T,
  validate?: (values: T) => Partial<Record<keyof T, string>>,
): FormVM<T> {
  const values$ = new BehaviorSubject<T>({ ...initial });
  const errors$ = new BehaviorSubject<Partial<Record<keyof T, string>>>({});
  const isSubmitting$ = new BehaviorSubject<boolean>(false);

  const isDirty$: Observable<boolean> = values$.pipe(
    map((v) => JSON.stringify(v) !== JSON.stringify(initial)),
  );

  const runValidation = () => {
    if (validate) errors$.next(validate(values$.getValue()));
  };

  return {
    values$: values$.asObservable(),
    errors$: errors$.asObservable(),
    isDirty$,
    isSubmitting$: isSubmitting$.asObservable(),
    setValue: (key, value) => {
      values$.next({ ...values$.getValue(), [key]: value });
      runValidation();
    },
    setValues: (partial) => {
      values$.next({ ...values$.getValue(), ...partial });
      runValidation();
    },
    reset: () => {
      values$.next({ ...initial });
      errors$.next({});
    },
    submit: async (handler) => {
      runValidation();
      const errs = errors$.getValue();
      if (Object.keys(errs).length > 0) return;
      isSubmitting$.next(true);
      try {
        await handler(values$.getValue());
      } finally {
        isSubmitting$.next(false);
      }
    },
    dispose: () => {
      values$.complete();
      errors$.complete();
      isSubmitting$.complete();
    },
  };
}
