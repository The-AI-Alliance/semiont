/**
 * Basic Graph Database Example
 *
 * This example demonstrates:
 * - Connecting to a graph database
 * - Creating documents and annotations
 * - Querying relationships
 * - Using different providers
 */

import { MemoryGraphDatabase } from '@semiont/graph/memory';
// import { Neo4jGraphDatabase } from '@semiont/graph/neo4j';

async function main() {
  // 1. Initialize graph database (using in-memory for example)
  const graph = new MemoryGraphDatabase();
  await graph.connect();
  console.log('✅ Connected to graph database');

  // For Neo4j, use:
  // const graph = new Neo4jGraphDatabase({
  //   uri: 'neo4j://localhost:7687',
  //   username: 'neo4j',
  //   password: 'password'
  // });

  // 2. Create a document
  const document = await graph.createDocument({
    id: 'doc-001',
    name: 'Research Paper',
    format: 'text/markdown',
    entityTypes: ['Person', 'Organization'],
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance: {
      createdBy: 'user-123',
      creationMethod: 'api'
    }
  });

  console.log('✅ Document created:', document.id);

  // 3. Create an annotation
  const annotation = await graph.createAnnotation({
    id: 'anno-001',
    target: {
      source: 'doc-001',
      selector: [{
        type: 'TextPositionSelector',
        start: 100,
        end: 150
      }]
    },
    body: [
      { type: 'TextualBody', value: 'John Smith', purpose: 'tagging' },
      { type: 'SpecificResource', source: 'doc-002' }
    ],
    creator: 'user-123',
    created: new Date().toISOString()
  });

  console.log('✅ Annotation created:', annotation.id);

  // 4. Query annotations for a document
  const annotations = await graph.getAnnotationsForDocument('doc-001');
  console.log(`\n📖 Found ${annotations.length} annotations for doc-001`);

  // 5. Find documents by entity types
  const personDocs = await graph.findDocumentsByEntityTypes(['Person']);
  console.log(`\n🔍 Found ${personDocs.length} documents tagged with 'Person'`);
  personDocs.forEach(doc => {
    console.log(`  - ${doc.name} (${doc.id})`);
  });

  // 6. Tag collection management
  await graph.addEntityType('Company');
  const entityTypes = await graph.getEntityTypes();
  console.log('\n🏷️ Available entity types:', entityTypes.join(', '));

  // 7. Update document
  const updated = await graph.updateDocument('doc-001', {
    archived: true
  });
  console.log('\n✅ Document archived:', updated?.archived);

  // 8. Cleanup (for demo)
  await graph.deleteAnnotation('anno-001');
  await graph.deleteDocument('doc-001');
  await graph.disconnect();

  console.log('\n✨ Example complete');
}

main().catch(console.error);