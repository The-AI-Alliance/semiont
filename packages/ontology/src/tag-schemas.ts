/**
 * Tag Schema Registry
 *
 * Defines structural analysis frameworks for automatic tagging detection.
 * Each schema provides categories that passages can be classified into
 * based on their structural role (not their semantic content).
 *
 * Examples: IRAC (legal), IMRAD (scientific), Toulmin (argumentation)
 */

export interface TagCategory {
  name: string;
  description: string;
  examples: string[];
}

export interface TagSchema {
  id: string;
  name: string;
  description: string;
  domain: 'legal' | 'scientific' | 'general';
  tags: TagCategory[];
}

export const TAG_SCHEMAS: Record<string, TagSchema> = {
  'legal-irac': {
    id: 'legal-irac',
    name: 'Legal Analysis (IRAC)',
    description: 'Issue, Rule, Application, Conclusion framework for legal reasoning',
    domain: 'legal',
    tags: [
      {
        name: 'Issue',
        description: 'The legal question or problem to be resolved',
        examples: [
          'What is the central legal question?',
          'What must the court decide?',
          'What is the dispute about?'
        ]
      },
      {
        name: 'Rule',
        description: 'The relevant law, statute, or legal principle',
        examples: [
          'What law applies?',
          'What is the legal standard?',
          'What statute governs this case?'
        ]
      },
      {
        name: 'Application',
        description: 'How the rule applies to the specific facts',
        examples: [
          'How does the law apply to these facts?',
          'Analysis of the case',
          'How do the facts satisfy the legal standard?'
        ]
      },
      {
        name: 'Conclusion',
        description: 'The resolution or outcome based on the analysis',
        examples: [
          'What is the court\'s decision?',
          'What is the final judgment?',
          'What is the holding?'
        ]
      }
    ]
  },

  'scientific-imrad': {
    id: 'scientific-imrad',
    name: 'Scientific Paper (IMRAD)',
    description: 'Introduction, Methods, Results, Discussion structure for research papers',
    domain: 'scientific',
    tags: [
      {
        name: 'Introduction',
        description: 'Background, context, and research question',
        examples: [
          'What is the research question?',
          'Why is this important?',
          'What is the hypothesis?'
        ]
      },
      {
        name: 'Methods',
        description: 'Experimental design and procedures',
        examples: [
          'How was the study conducted?',
          'What methods were used?',
          'What was the experimental design?'
        ]
      },
      {
        name: 'Results',
        description: 'Findings and observations',
        examples: [
          'What did the study find?',
          'What are the data?',
          'What were the observations?'
        ]
      },
      {
        name: 'Discussion',
        description: 'Interpretation and implications of results',
        examples: [
          'What do the results mean?',
          'What are the implications?',
          'How do these findings relate to prior work?'
        ]
      }
    ]
  },

  'argument-toulmin': {
    id: 'argument-toulmin',
    name: 'Argument Structure (Toulmin)',
    description: 'Claim, Evidence, Warrant, Counterargument, Rebuttal framework for argumentation',
    domain: 'general',
    tags: [
      {
        name: 'Claim',
        description: 'The main assertion or thesis',
        examples: [
          'What is being argued?',
          'What is the main point?',
          'What position is being taken?'
        ]
      },
      {
        name: 'Evidence',
        description: 'Data or facts supporting the claim',
        examples: [
          'What supports this claim?',
          'What are the facts?',
          'What data is provided?'
        ]
      },
      {
        name: 'Warrant',
        description: 'Reasoning connecting evidence to claim',
        examples: [
          'Why does this evidence support the claim?',
          'What is the logic?',
          'How does this reasoning work?'
        ]
      },
      {
        name: 'Counterargument',
        description: 'Opposing viewpoints or objections',
        examples: [
          'What are the objections?',
          'What do critics say?',
          'What are alternative views?'
        ]
      },
      {
        name: 'Rebuttal',
        description: 'Response to counterarguments',
        examples: [
          'How is the objection addressed?',
          'Why is the counterargument wrong?',
          'How is the criticism answered?'
        ]
      }
    ]
  }
};

/**
 * Get a tag schema by ID
 */
export function getTagSchema(schemaId: string): TagSchema | null {
  return TAG_SCHEMAS[schemaId] || null;
}

/**
 * Get all available tag schemas
 */
export function getAllTagSchemas(): TagSchema[] {
  return Object.values(TAG_SCHEMAS);
}

/**
 * Get tag schemas filtered by domain
 */
export function getTagSchemasByDomain(domain: 'legal' | 'scientific' | 'general'): TagSchema[] {
  return Object.values(TAG_SCHEMAS).filter(schema => schema.domain === domain);
}

/**
 * Validate that a category name is valid for a schema
 */
export function isValidCategory(schemaId: string, categoryName: string): boolean {
  const schema = getTagSchema(schemaId);
  if (!schema) return false;
  return schema.tags.some(tag => tag.name === categoryName);
}

/**
 * Get a specific category from a schema
 */
export function getSchemaCategory(schemaId: string, categoryName: string): TagCategory | null {
  const schema = getTagSchema(schemaId);
  if (!schema) return null;
  return schema.tags.find(tag => tag.name === categoryName) || null;
}
