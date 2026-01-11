# Offset Validation and Correction

The entity extraction system includes sophisticated offset validation and correction to ensure character positions are accurate despite AI hallucination or miscalculation.

## The Problem

When AI models extract entities from text and provide character offsets, they can make errors:

1. **Off-by-one errors**: Model reports offset 10 when correct offset is 11
2. **Unicode miscounting**: Model counts UTF-16 code units instead of characters
3. **Whitespace miscounting**: Model includes or excludes leading/trailing whitespace
4. **Multiple occurrences**: Same text appears multiple times; wrong occurrence selected

From [src/entity-extractor.ts:147-151](../src/entity-extractor.ts):
```typescript
// Verify the offsets are correct by checking if the text matches
const extractedText = exact.substring(startOffset, endOffset);

// If the extracted text doesn't match, find the correct position using context
if (extractedText !== entity.exact) {
  // Correction algorithm begins...
}
```

## Solution: Context-Based Correction

The system validates every offset and corrects misalignments using prefix/suffix context.

### Step 1: Validate Offset

From [src/entity-extractor.ts:147-161](../src/entity-extractor.ts):

```typescript
const extractedText = exact.substring(startOffset, endOffset);

if (extractedText !== entity.exact) {
  console.log(`  ⚠️  Offset mismatch!`);
  console.log(`  Expected: "${entity.exact}"`);
  console.log(`  Found at AI offsets [${startOffset}:${endOffset}]: "${extractedText}"`);

  // Show context around the AI-provided offset
  const contextStart = Math.max(0, startOffset - 50);
  const contextEnd = Math.min(exact.length, endOffset + 50);
  const contextBefore = exact.substring(contextStart, startOffset);
  const contextAfter = exact.substring(endOffset, contextEnd);
  console.log(`  Context: "...${contextBefore}[${extractedText}]${contextAfter}..."`);
}
```

This provides diagnostic output showing exactly what went wrong.

### Step 2: Request Context from AI

From [src/entity-extractor.ts:84-90](../src/entity-extractor.ts):

The AI is prompted to include prefix and suffix for disambiguation:

```typescript
- prefix: up to 32 characters of text immediately before the entity (helps identify correct occurrence)
- suffix: up to 32 characters of text immediately after the entity (helps identify correct occurrence)
```

This context enables finding the correct occurrence when the same text appears multiple times.

### Step 3: Search Using Context

From [src/entity-extractor.ts:165-196](../src/entity-extractor.ts):

```typescript
if (entity.prefix || entity.suffix) {
  console.log(`  Using LLM-provided context for disambiguation:`);
  if (entity.prefix) console.log(`    Prefix: "${entity.prefix}"`);
  if (entity.suffix) console.log(`    Suffix: "${entity.suffix}"`);

  // Search for all occurrences and find the one with matching context
  let searchPos = 0;
  while ((searchPos = exact.indexOf(entity.exact, searchPos)) !== -1) {
    const candidatePrefix = exact.substring(Math.max(0, searchPos - 32), searchPos);
    const candidateSuffix = exact.substring(
      searchPos + entity.exact.length,
      Math.min(exact.length, searchPos + entity.exact.length + 32)
    );

    // Check if context matches (allowing for partial matches at boundaries)
    const prefixMatch = !entity.prefix || candidatePrefix.endsWith(entity.prefix);
    const suffixMatch = !entity.suffix || candidateSuffix.startsWith(entity.suffix);

    if (prefixMatch && suffixMatch) {
      console.log(`  ✅ Found match using context at offset ${searchPos} (diff: ${searchPos - startOffset})`);
      startOffset = searchPos;
      endOffset = searchPos + entity.exact.length;
      found = true;
      break;
    }

    searchPos++;
  }
}
```

### Step 4: Fallback to Simple Search

From [src/entity-extractor.ts:203-219](../src/entity-extractor.ts):

If context matching fails, fall back to finding the first occurrence:

```typescript
if (!found) {
  const firstOccurrence = exact.indexOf(entity.exact);
  if (firstOccurrence !== -1) {
    console.log(`  ⚠️  Using first occurrence at offset ${firstOccurrence} (diff: ${firstOccurrence - startOffset})`);
    startOffset = firstOccurrence;
    endOffset = firstOccurrence + entity.exact.length;
  } else {
    console.warn(`  ❌ Entity text not found in resource. Skipping this entity.`);
    console.warn(`     Entity: "${entity.exact}"`);
    return null; // Will be filtered out
  }
}
```

### Step 5: Filter Invalid Entities

From [src/entity-extractor.ts:221-248](../src/entity-extractor.ts):

After correction attempts, validate the final offsets:

```typescript
// Final validation
if (startOffset < 0 || endOffset > exact.length || startOffset >= endOffset) {
  console.warn(`  ❌ Invalid offsets after correction: [${startOffset}, ${endOffset}]`);
  return null;
}

const finalCheck = exact.substring(startOffset, endOffset);
if (finalCheck !== entity.exact) {
  console.warn(`  ❌ Final verification failed`);
  console.warn(`     Expected: "${entity.exact}"`);
  console.warn(`     Got: "${finalCheck}"`);
  return null;
}

console.log(`  ✅ Final validated offsets: [${startOffset}, ${endOffset}]`);
```

Invalid entities return `null` and are filtered from results:

From [src/entity-extractor.ts:251](../src/entity-extractor.ts):
```typescript
}).filter((e): e is ExtractedEntity => e !== null);
```

## Error Conditions

### Truncated Response

From [src/entity-extractor.ts:131-135](../src/entity-extractor.ts):

If the AI response is truncated, the system throws an error rather than returning incomplete results:

```typescript
if (response.stop_reason === 'max_tokens') {
  const errorMsg = `AI response truncated: Found ${entities.length} entities but response hit max_tokens limit. Increase max_tokens or reduce resource size.`;
  console.error(`❌ ${errorMsg}`);
  throw new Error(errorMsg);
}
```

This prevents silent data loss when processing large documents.

### Parse Errors

From [src/entity-extractor.ts:254-257](../src/entity-extractor.ts):

If the AI returns invalid JSON, return empty array rather than throwing:

```typescript
} catch (error) {
  console.warn('Failed to parse entity extraction response:', error);
  return [];
}
```

This graceful degradation prevents one bad response from breaking the entire pipeline.

## Configuration

From [src/entity-extractor.ts:101-108](../src/entity-extractor.ts):

The extraction is configured for reliability:

```typescript
const response = await client.messages.create({
  model: getInferenceModel(config),
  max_tokens: 4000,        // Increased to handle many entities without truncation
  temperature: 0.3,        // Lower temperature for more consistent extraction
  messages: [/* ... */]
});
```

- **4000 max_tokens**: Handles documents with hundreds of entities
- **Temperature 0.3**: Balances consistency with flexibility

## Example: Correcting an Offset Error

**Input text:**
```
Marie Curie was born in Warsaw. She was the first woman to win a Nobel Prize.
```

**AI response (with error):**
```json
{
  "exact": "Marie Curie",
  "entityType": "Person",
  "startOffset": 1,        // Wrong! Should be 0
  "endOffset": 12,         // Wrong! Should be 11
  "prefix": "",
  "suffix": " was born in Warsaw"
}
```

**Validation detects mismatch:**
```
⚠️  Offset mismatch!
Expected: "Marie Curie"
Found at AI offsets [1:12]: "arie Curie "
```

**Context-based search finds correct position:**
```
✅ Found match using context at offset 0 (diff: -1)
Candidate prefix: ""
Candidate suffix: " was born in Warsaw"
```

**Final result:**
```json
{
  "exact": "Marie Curie",
  "entityType": "Person",
  "startOffset": 0,        // Corrected!
  "endOffset": 11,         // Corrected!
  "prefix": "",
  "suffix": " was born in Warsaw"
}
```

## Performance Considerations

From [src/entity-extractor.ts:172-196](../src/entity-extractor.ts):

The context matching algorithm is O(n×m) where:
- n = number of occurrences of the entity text
- m = length of entity text

For typical documents with < 10 occurrences per entity, this is fast enough. The alternative (asking AI to regenerate) would be much slower.

## Logging

The system provides detailed console logging at every step:

1. **Request**: Entity types, text length, configuration
2. **Response**: Raw response length, parsed entity count
3. **Validation**: Each entity's offsets, mismatches detected
4. **Correction**: Context matching attempts, success/failure
5. **Results**: Final validated offsets, filtered entities

This diagnostic output makes debugging offset issues straightforward.
