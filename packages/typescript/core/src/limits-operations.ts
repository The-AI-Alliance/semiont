/**
 * The operations that report inference limits — one per service that holds
 * inference credentials (the worker: `job:`; the librarian: `gather:`,
 * `match:`), each named `<flow>:limits-requested`. Derived from the bus
 * registry by that name, so a new key holder's operation joins by being
 * registered.
 */
import { BUS_OPERATIONS, type BusOperationKey } from './bus-operations';

export type LimitsOperation = Extract<BusOperationKey, `${string}:limits-requested`>;

export const LIMITS_OPERATIONS: readonly LimitsOperation[] = (Object.keys(BUS_OPERATIONS) as BusOperationKey[])
  .filter((op): op is LimitsOperation => op.endsWith(':limits-requested'));
