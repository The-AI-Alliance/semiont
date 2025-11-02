/**
 * Event Validator - Event Chain Integrity
 *
 * Validates event chain integrity using cryptographic hashing:
 * - prevEventHash links to previous event's checksum
 * - Each event's checksum is verified against its payload
 * - Detects broken chains and tampered events
 *
 * @see docs/EVENT-STORE.md#eventvalidator for architecture details
 */

import type { StoredEvent } from '@semiont/core';
import { resourceId, userId, annotationId } from '@semiont/core';
import { sha256 } from '../../storage/shard-utils';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * EventValidator verifies event chain integrity
 * Uses cryptographic checksums to detect broken chains or tampering
 */
export class EventValidator {
  /**
   * Validate event chain integrity for a resource's events
   * Checks that each event properly links to the previous event
   */
  validateEventChain(events: StoredEvent[]): ValidationResult {
    const errors: string[] = [];

    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];

      if (!prev || !curr) continue;

      // Check prevEventHash points to previous event
      if (curr.metadata.prevEventHash !== prev.metadata.checksum) {
        errors.push(
          `Event chain broken at sequence ${curr.metadata.sequenceNumber}: ` +
          `prevEventHash=${curr.metadata.prevEventHash} but previous checksum=${prev.metadata.checksum}`
        );
      }

      // Verify checksum of current event
      const calculated = sha256(curr.event);
      if (calculated !== curr.metadata.checksum) {
        errors.push(
          `Checksum mismatch at sequence ${curr.metadata.sequenceNumber}: ` +
          `calculated=${calculated} but stored=${curr.metadata.checksum}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate a single event's checksum
   * Useful for validating events before writing them
   */
  validateEventChecksum(event: StoredEvent): boolean {
    const calculated = sha256(event.event);
    return calculated === event.metadata.checksum;
  }

  /**
   * Validate that an event properly links to a previous event
   * Returns true if the link is valid or if this is the first event
   */
  validateEventLink(currentEvent: StoredEvent, previousEvent: StoredEvent | null): boolean {
    // First event in chain should have no prevEventHash
    if (!previousEvent) {
      return !currentEvent.metadata.prevEventHash;
    }

    // Subsequent events should link to previous event's checksum
    return currentEvent.metadata.prevEventHash === previousEvent.metadata.checksum;
  }
}
