/**
 * How a case states a value it expects. A pattern is JSON, compared exactly:
 * the same scalars, the same list, the same keys. The one operator is
 * `{"$var": "name"}`: the first time a name is met it takes the value found
 * there, and every later use must equal it, so a case can say "the same
 * client id" or "the correlation id that request carried" without knowing
 * either. `_` takes anything and keeps nothing. `{"$join": [...]}` is the
 * text its parts make end to end, each a string or a variable already bound:
 * a watermark is `p-`, a scope, `-` and a sequence number.
 */
import { isDeepStrictEqual } from 'node:util';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const variable = (v: unknown): string | undefined => {
  if (!isObject(v)) return undefined;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === '$var' && typeof v['$var'] === 'string' ? v['$var'] : undefined;
};

const joined = (v: unknown): unknown[] | undefined => {
  if (!isObject(v)) return undefined;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === '$join' && Array.isArray(v['$join']) ? v['$join'] : undefined;
};

/** An object without the keys whose value is undefined: what it is once written as JSON. */
const present = (v: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined));

const show = (v: unknown): string => {
  const text = JSON.stringify(v);
  return text === undefined ? 'nothing' : text.length > 400 ? `${text.slice(0, 400)}…` : text;
};

export class Bindings {
  private readonly values = new Map<string, unknown>();

  bind(name: string, value: unknown): void {
    if (this.values.has(name)) throw new Error(`${name} is already bound`);
    this.values.set(name, value);
  }

  get(name: string): unknown {
    if (!this.values.has(name)) throw new Error(`${name} is not bound yet`);
    return this.values.get(name);
  }

  /** `template` with every variable replaced by its value. A variable not yet bound is the case's mistake. */
  resolve(template: unknown): unknown {
    const name = variable(template);
    if (name !== undefined) return this.get(name);
    const parts = joined(template);
    if (parts !== undefined) return parts.map((part) => String(this.resolve(part))).join('');
    if (Array.isArray(template)) return template.map((item) => this.resolve(item));
    if (isObject(template)) return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, this.resolve(value)]));
    return template;
  }

  /**
   * Whether `value` is what `pattern` states. Returns the first difference, or
   * undefined when there is none; only then are the variables it met bound.
   */
  match(pattern: unknown, value: unknown): string | undefined {
    const met = new Map<string, unknown>();
    const difference = this.compare(pattern, value, '', met);
    if (difference === undefined) for (const [name, taken] of met) this.values.set(name, taken);
    return difference;
  }

  private compare(pattern: unknown, value: unknown, at: string, met: Map<string, unknown>): string | undefined {
    const where = at || 'the value';
    const name = variable(pattern);
    if (name !== undefined) {
      if (name === '_') return value === undefined ? `${where} is missing` : undefined;
      const known = this.values.has(name) ? this.values.get(name) : met.get(name);
      if (this.values.has(name) || met.has(name)) {
        return isDeepStrictEqual(known, value) ? undefined : `${where} is ${show(value)}, not ${name} (${show(known)})`;
      }
      if (value === undefined) return `${where} is missing, so ${name} has nothing to take`;
      met.set(name, value);
      return undefined;
    }
    if (joined(pattern) !== undefined) {
      const text = this.resolve(pattern);
      return text === value ? undefined : `${where} is ${show(value)}, not ${show(text)}`;
    }
    if (Array.isArray(pattern)) {
      if (!Array.isArray(value)) return `${where} is ${show(value)}, not a list`;
      if (value.length !== pattern.length) return `${where} has ${value.length} entries, not ${pattern.length}: ${show(value)}`;
      for (const [index, item] of pattern.entries()) {
        const difference = this.compare(item, value[index], `${at}[${index}]`, met);
        if (difference !== undefined) return difference;
      }
      return undefined;
    }
    if (isObject(pattern)) {
      if (!isObject(value)) return `${where} is ${show(value)}, not an object`;
      const given = present(value);
      for (const key of Object.keys(given)) if (!(key in pattern)) return `${where} carries ${key} (${show(given[key])}), which was not expected`;
      for (const [key, expected] of Object.entries(pattern)) {
        const difference = this.compare(expected, given[key], at ? `${at}.${key}` : key, met);
        if (difference !== undefined) return difference;
      }
      return undefined;
    }
    return isDeepStrictEqual(pattern, value) ? undefined : `${where} is ${show(value)}, not ${show(pattern)}`;
  }
}
