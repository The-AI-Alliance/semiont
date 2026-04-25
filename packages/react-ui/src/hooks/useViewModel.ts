'use client';

import { useState, useEffect } from 'react';
import type { ViewModel } from '@semiont/sdk';
export function useViewModel<VM extends ViewModel>(factory: () => VM): VM {
  const [vm] = useState(factory);
  useEffect(() => () => vm.dispose(), [vm]);
  return vm;
}
