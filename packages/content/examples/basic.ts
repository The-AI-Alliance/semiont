/**
 * Basic Content Storage Example
 *
 * This example demonstrates:
 * - Storing content with checksums
 * - Retrieving content
 * - Automatic deduplication
 * - Multiple representations
 */

import { FilesystemRepresentationStore } from '@semiont/content';
import { calculateChecksum, verifyChecksum } from '@semiont/content';

async function main() {
  // 1. Initialize content store
  const store = new FilesystemRepresentationStore({
    basePath: './data/storage'
  });

  console.log('✅ Content store initialized');

  // 2. Store text content
  const textContent = Buffer.from('This is my document content.');

  const storedText = await store.store(textContent, {
    mediaType: 'text/plain',
    language: 'en',
    rel: 'original'
  });

  console.log('\n📄 Stored text document:');
  console.log(`  Checksum: ${storedText.checksum}`);
  console.log(`  Size: ${storedText.size} bytes`);

  // 3. Retrieve content
  const retrieved = await store.get(storedText.checksum);
  const retrievedText = retrieved.toString('utf-8');

  console.log(`\n📖 Retrieved content: "${retrievedText}"`);

  // 4. Verify integrity
  const isValid = await verifyChecksum(retrieved, storedText.checksum);
  console.log(`\n✅ Content integrity verified: ${isValid}`);

  // 5. Demonstrate deduplication
  console.log('\n🔄 Testing deduplication...');

  const duplicate = await store.store(textContent, {
    mediaType: 'text/plain',
    rel: 'copy'
  });

  console.log(`  Original checksum: ${storedText.checksum}`);
  console.log(`  Duplicate checksum: ${duplicate.checksum}`);
  console.log(`  Same checksum: ${storedText.checksum === duplicate.checksum}`);
  console.log('  (Only one file on disk!)');

  // 6. Store multiple representations
  console.log('\n🌐 Storing multiple representations...');

  // Markdown version
  const markdownContent = Buffer.from('# Document Title\n\nThis is my document content.');
  const storedMarkdown = await store.store(markdownContent, {
    mediaType: 'text/markdown',
    rel: 'derived'
  });

  // Spanish translation
  const spanishContent = Buffer.from('Este es el contenido de mi documento.');
  const storedSpanish = await store.store(spanishContent, {
    mediaType: 'text/plain',
    language: 'es',
    rel: 'translation'
  });

  console.log('  Stored 3 representations:');
  console.log(`    - Original (en): ${storedText.checksum}`);
  console.log(`    - Markdown: ${storedMarkdown.checksum}`);
  console.log(`    - Spanish: ${storedSpanish.checksum}`);

  // 7. Store binary content
  console.log('\n🖼️ Storing binary content...');

  // Create a simple PNG header (smallest valid PNG)
  const pngData = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,  // PNG signature
    0x00, 0x00, 0x00, 0x0D,  // IHDR length
    0x49, 0x48, 0x44, 0x52,  // IHDR
    0x00, 0x00, 0x00, 0x01,  // width = 1
    0x00, 0x00, 0x00, 0x01,  // height = 1
    0x08, 0x02,              // bit depth = 8, color type = 2 (RGB)
    0x00, 0x00, 0x00,        // compression, filter, interlace
    0x90, 0x77, 0x53, 0xDE,  // CRC
    0x00, 0x00, 0x00, 0x0C,  // IDAT length
    0x49, 0x44, 0x41, 0x54,  // IDAT
    0x08, 0x99, 0x01, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x99, 0x7F,  // compressed data
    0x83, 0x3C, 0xE0, 0x00,  // CRC
    0x00, 0x00, 0x00, 0x00,  // IEND length
    0x49, 0x45, 0x4E, 0x44,  // IEND
    0xAE, 0x42, 0x60, 0x82   // CRC
  ]);

  const storedImage = await store.store(pngData, {
    mediaType: 'image/png'
  });

  console.log(`  Stored PNG image: ${storedImage.checksum}`);
  console.log(`  Size: ${storedImage.size} bytes`);

  // 8. Check existence
  console.log('\n🔍 Checking content existence...');

  const exists1 = await store.exists(storedText.checksum);
  const exists2 = await store.exists('sha256:nonexistent');

  console.log(`  Text content exists: ${exists1}`);
  console.log(`  Nonexistent content: ${exists2}`);

  // 9. Calculate checksum manually
  const manualChecksum = calculateChecksum(textContent);
  console.log(`\n🔐 Manual checksum calculation: ${manualChecksum}`);
  console.log(`  Matches stored: ${manualChecksum === storedText.checksum}`);

  // 10. Cleanup (optional)
  console.log('\n🗑️ Cleaning up...');

  await store.delete(storedText.checksum);
  await store.delete(storedMarkdown.checksum);
  await store.delete(storedSpanish.checksum);
  await store.delete(storedImage.checksum);

  console.log('  Deleted all test content');

  console.log('\n✨ Example complete');
}

main().catch(console.error);