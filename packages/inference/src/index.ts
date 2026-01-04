// Factory and inference clients
export {
  getInferenceClient,
  getInferenceModel,
  generateText,
  generateResourceFromTopic,
  generateResourceSummary,
  generateReferenceSuggestions,
} from './factory';

// Entity extraction
export {
  extractEntities,
  type ExtractedEntity,
} from './entity-extractor';
