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

// Motivation prompt builders
export { MotivationPrompts } from './motivation-prompts';

// Motivation response parsers
export {
  MotivationParsers,
  type CommentMatch,
  type HighlightMatch,
  type AssessmentMatch,
  type TagMatch,
} from './motivation-parsers';
