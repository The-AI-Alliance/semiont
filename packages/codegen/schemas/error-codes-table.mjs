// error-codes-table.mjs — the one reading of specs/src/errors/codes.json that
// every generator of it shares: the table, held to account. It refuses a table
// that disagrees with the wire's own vocabulary (`CommandError.code`) in
// either direction, or that says one thing twice.

import { readFileSync } from 'node:fs';

/**
 * The table at `tablePath`, read and checked against `CommandError.code` at
 * `commandErrorPath`. `refuse(message)` is called for a table that cannot be
 * generated from, and does not return.
 */
export function readErrorCodes(tablePath, commandErrorPath, refuse) {
  /** A vocabulary's codes, each stated once and each documented. */
  function codesOf(name, vocabulary) {
    if (!vocabulary || !Array.isArray(vocabulary.codes) || vocabulary.codes.length === 0) {
      refuse(`"${name}" lists no codes`);
    }
    if (typeof vocabulary.docs !== 'string' || vocabulary.docs === '') refuse(`"${name}" has no docs`);
    const seen = new Set();
    for (const entry of vocabulary.codes) {
      if (typeof entry.code !== 'string' || entry.code === '') refuse(`"${name}" has an entry with no code`);
      if (seen.has(entry.code)) refuse(`"${name}" states ${entry.code} twice`);
      seen.add(entry.code);
      if (typeof entry.docs !== 'string' || entry.docs === '') refuse(`${entry.code} has no docs`);
    }
    return vocabulary.codes;
  }

  const table = JSON.parse(readFileSync(tablePath, 'utf8'));
  const wireCodes = JSON.parse(readFileSync(commandErrorPath, 'utf8')).properties.code.enum;

  // ── busRequest ──────────────────────────────────────────────────────────
  const busCodes = codesOf('busRequest', table.busRequest);
  const busByWire = new Map();
  for (const entry of busCodes) {
    if (entry.wire === undefined) continue;
    if (!wireCodes.includes(entry.wire)) {
      refuse(`${entry.code} restates the wire code "${entry.wire}", which CommandError.code does not declare`);
    }
    if (busByWire.has(entry.wire)) {
      refuse(`the wire code "${entry.wire}" becomes both ${busByWire.get(entry.wire)} and ${entry.code}`);
    }
    busByWire.set(entry.wire, entry.code);
  }
  for (const wire of wireCodes) {
    if (!busByWire.has(wire)) refuse(`CommandError.code declares "${wire}", and no busRequest code restates it`);
  }
  const unrecognized = busCodes.find((entry) => entry.code === table.busRequest.unrecognizedFailure);
  if (!unrecognized) refuse(`busRequest.unrecognizedFailure names "${table.busRequest.unrecognizedFailure}", which is not one of its codes`);
  if (unrecognized.wire !== undefined) refuse(`busRequest.unrecognizedFailure is ${unrecognized.code}, which restates a wire code; an unrecognized failure cannot be a recognized one`);

  // ── transport ───────────────────────────────────────────────────────────
  const transportCodes = codesOf('transport', table.transport);
  const byStatus = new Map();
  const ranges = [];
  for (const entry of transportCodes) {
    if (entry.status !== undefined && entry.statusFrom !== undefined) {
      refuse(`${entry.code} states both a status and a statusFrom`);
    }
    if (entry.status !== undefined) {
      if (!Number.isInteger(entry.status)) refuse(`${entry.code}'s status is not an integer`);
      if (byStatus.has(entry.status)) refuse(`status ${entry.status} is both ${byStatus.get(entry.status)} and ${entry.code}`);
      byStatus.set(entry.status, entry.code);
    }
    if (entry.statusFrom !== undefined) {
      if (!Number.isInteger(entry.statusFrom)) refuse(`${entry.code}'s statusFrom is not an integer`);
      ranges.push(entry);
    }
  }
  if (ranges.length > 1) refuse(`${ranges.map((entry) => entry.code).join(' and ')} each state a statusFrom; one open range is all a status can fall in`);
  for (const [status, code] of byStatus) {
    if (ranges[0] && status >= ranges[0].statusFrom) {
      refuse(`status ${status} is ${code} and also falls in ${ranges[0].code}'s range`);
    }
  }
  const unclassified = transportCodes.find((entry) => entry.code === table.transport.unclassified);
  if (!unclassified) refuse(`transport.unclassified names "${table.transport.unclassified}", which is not one of its codes`);
  if (unclassified.status !== undefined || unclassified.statusFrom !== undefined) {
    refuse(`transport.unclassified is ${unclassified.code}, which a status already maps to`);
  }
  for (const entry of transportCodes) {
    if (entry !== unclassified && entry.status === undefined && entry.statusFrom === undefined) {
      refuse(`${entry.code} maps from no status and is not the unclassified code, so nothing produces it`);
    }
  }

  // ── job ─────────────────────────────────────────────────────────────────
  const jobCodes = codesOf('job', table.job);

  // ── session ─────────────────────────────────────────────────────────────
  const sessionCodes = codesOf('session', table.session);

  // ── sign-in, and the identity a sign-in must establish ──────────────────
  const signInCodes = codesOf('signIn', table.signIn);
  const kbIdentityCodes = codesOf('kbIdentity', table.kbIdentity);

  // ── why an annotation builder refused a span ────────────────────────────
  const spanRefusalCodes = codesOf('spanRefusal', table.spanRefusal);

  return { table, busCodes, busByWire, unrecognized, transportCodes, byStatus, ranges, unclassified, jobCodes, sessionCodes, signInCodes, kbIdentityCodes, spanRefusalCodes };
}
