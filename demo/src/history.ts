/**
 * Document History
 *
 * Utilities for retrieving and displaying document event history.
 */

import type { SemiontApiClient } from '@semiont/api-client';
import { resourceUri } from '@semiont/api-client';
import { printInfo, printWarning, printEventBreakdown, printEvent, type EventDetails } from './display';

/**
 * Show document event history
 */
export async function showDocumentHistory(tocId: string, client: SemiontApiClient): Promise<void> {
  try {
    const data = await client.getResourceEvents(resourceUri(tocId));

    if (!data.events || data.events.length === 0) {
      printWarning('No events found for document');
      return;
    }

    const storedEvents = data.events;
    printInfo(`Total events: ${storedEvents.length}`);
    console.log('');

    // Group events by type
    const eventsByType: Record<string, number> = {};
    storedEvents.forEach((stored: any) => {
      const type = stored.event?.type || 'unknown';
      eventsByType[type] = (eventsByType[type] || 0) + 1;
    });

    printEventBreakdown(eventsByType);

    // Show recent events (last 10)
    console.log('   Recent events:');
    const recentEvents = storedEvents.slice(-10);
    recentEvents.forEach((stored: any, index: number) => {
      const event = stored.event;
      if (!event) return;

      const eventNum = storedEvents.length - recentEvents.length + index + 1;
      const eventDetails: EventDetails = {
        eventNum,
        sequenceNumber: stored.metadata?.sequenceNumber || '?',
        type: event.type,
        payload: event.payload,
      };

      printEvent(eventDetails);
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printWarning(`Error fetching history: ${message}`);
  }
}
