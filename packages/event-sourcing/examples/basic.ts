/**
 * Basic Event Sourcing Example
 *
 * This example demonstrates:
 * - Creating an event store
 * - Appending events
 * - Reading events
 * - Subscribing to events
 */

import { createEventStore } from '@semiont/event-sourcing';
import { resourceId, userId } from '@semiont/core';
import type { EnvironmentConfig } from '@semiont/core';

async function main() {
  // 1. Initialize event store
  const config: EnvironmentConfig = {
    services: {
      filesystem: { path: './data' },
      backend: { publicURL: 'http://localhost:4000' }
    }
  };

  const eventStore = await createEventStore(config);

  // 2. Create a resource
  const docId = resourceId('doc-example-001');
  const user = userId('user-123');

  await eventStore.appendEvent({
    type: 'resource.created',
    userId: user,
    resourceId: docId,
    payload: {
      name: 'Example Document',
      format: 'text/plain',
      creationMethod: 'api'
    }
  });

  console.log('✅ Resource created');

  // 3. Add an annotation
  await eventStore.appendEvent({
    type: 'annotation.added',
    userId: user,
    resourceId: docId,
    payload: {
      annotation: {
        id: 'anno-001',
        target: { source: docId },
        body: [{ value: 'Important note' }]
      }
    }
  });

  console.log('✅ Annotation added');

  // 4. Read events
  const events = await eventStore.log.getEvents(docId);
  console.log(`\n📖 Found ${events.length} events:`);
  events.forEach(event => {
    console.log(`  - ${event.event.type} at ${event.event.timestamp}`);
  });

  // 5. Subscribe to future events
  const subscription = eventStore.bus.subscribe(docId, (event) => {
    console.log(`\n�� New event: ${event.event.type}`);
  });

  // 6. Add another event (will trigger subscription)
  await eventStore.appendEvent({
    type: 'entitytag.added',
    userId: user,
    resourceId: docId,
    payload: { entityType: 'Person' }
  });

  // 7. Cleanup
  subscription.unsubscribe();
  console.log('\n✨ Example complete');
}

main().catch(console.error);