/**
 * The translation a framework-agnostic component is handed: a key of the
 * host's section for it, and the string. No such component interpolates.
 */
export type TranslateFn = (key: string) => string;
