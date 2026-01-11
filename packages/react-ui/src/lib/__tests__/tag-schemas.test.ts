import { describe, it, expect } from 'vitest';
import {
  TAG_SCHEMAS,
  getTagSchema,
  getAllTagSchemas,
  getTagSchemasByDomain,
  isValidCategory,
  getTagCategory,
  type TagSchema,
  type TagCategory,
} from '../tag-schemas';

describe('TAG_SCHEMAS', () => {
  describe('Schema Structure', () => {
    it('should contain all expected schemas', () => {
      const schemaIds = Object.keys(TAG_SCHEMAS);

      expect(schemaIds).toContain('legal-irac');
      expect(schemaIds).toContain('scientific-imrad');
      expect(schemaIds).toContain('argument-toulmin');
      expect(schemaIds).toHaveLength(3);
    });

    it('should have schemas with required properties', () => {
      Object.values(TAG_SCHEMAS).forEach(schema => {
        expect(schema).toHaveProperty('id');
        expect(schema).toHaveProperty('name');
        expect(schema).toHaveProperty('description');
        expect(schema).toHaveProperty('domain');
        expect(schema).toHaveProperty('tags');

        expect(typeof schema.id).toBe('string');
        expect(typeof schema.name).toBe('string');
        expect(typeof schema.description).toBe('string');
        expect(['legal', 'scientific', 'general']).toContain(schema.domain);
        expect(Array.isArray(schema.tags)).toBe(true);
      });
    });

    it('should have tags with required properties', () => {
      Object.values(TAG_SCHEMAS).forEach(schema => {
        schema.tags.forEach(tag => {
          expect(tag).toHaveProperty('name');
          expect(tag).toHaveProperty('description');
          expect(tag).toHaveProperty('examples');

          expect(typeof tag.name).toBe('string');
          expect(typeof tag.description).toBe('string');
          expect(Array.isArray(tag.examples)).toBe(true);
          expect(tag.examples.length).toBeGreaterThan(0);
          tag.examples.forEach(example => {
            expect(typeof example).toBe('string');
          });
        });
      });
    });

    it('should have schema IDs matching their keys', () => {
      Object.entries(TAG_SCHEMAS).forEach(([key, schema]) => {
        expect(schema.id).toBe(key);
      });
    });
  });

  describe('Legal IRAC Schema', () => {
    const schema = TAG_SCHEMAS['legal-irac'];

    it('should have correct metadata', () => {
      expect(schema.id).toBe('legal-irac');
      expect(schema.name).toBe('Legal Analysis (IRAC)');
      expect(schema.description).toBe('Issue, Rule, Application, Conclusion framework for legal reasoning');
      expect(schema.domain).toBe('legal');
    });

    it('should have IRAC tags in order', () => {
      expect(schema.tags).toHaveLength(4);
      expect(schema.tags[0].name).toBe('Issue');
      expect(schema.tags[1].name).toBe('Rule');
      expect(schema.tags[2].name).toBe('Application');
      expect(schema.tags[3].name).toBe('Conclusion');
    });

    it('should have Issue tag with examples', () => {
      const issueTag = schema.tags.find(t => t.name === 'Issue');

      expect(issueTag).toBeDefined();
      expect(issueTag!.description).toBe('The legal question or problem to be resolved');
      expect(issueTag!.examples).toContain('What is the central legal question?');
      expect(issueTag!.examples.length).toBeGreaterThanOrEqual(3);
    });

    it('should have Rule tag with examples', () => {
      const ruleTag = schema.tags.find(t => t.name === 'Rule');

      expect(ruleTag).toBeDefined();
      expect(ruleTag!.description).toBe('The relevant law, statute, or legal principle');
      expect(ruleTag!.examples).toContain('What law applies?');
    });

    it('should have Application tag with examples', () => {
      const applicationTag = schema.tags.find(t => t.name === 'Application');

      expect(applicationTag).toBeDefined();
      expect(applicationTag!.description).toBe('How the rule applies to the specific facts');
      expect(applicationTag!.examples).toContain('How does the law apply to these facts?');
    });

    it('should have Conclusion tag with examples', () => {
      const conclusionTag = schema.tags.find(t => t.name === 'Conclusion');

      expect(conclusionTag).toBeDefined();
      expect(conclusionTag!.description).toBe('The resolution or outcome based on the analysis');
      expect(conclusionTag!.examples).toContain('What is the court\'s decision?');
    });
  });

  describe('Scientific IMRAD Schema', () => {
    const schema = TAG_SCHEMAS['scientific-imrad'];

    it('should have correct metadata', () => {
      expect(schema.id).toBe('scientific-imrad');
      expect(schema.name).toBe('Scientific Paper (IMRAD)');
      expect(schema.description).toBe('Introduction, Methods, Results, Discussion structure for research papers');
      expect(schema.domain).toBe('scientific');
    });

    it('should have IMRAD tags in order', () => {
      expect(schema.tags).toHaveLength(4);
      expect(schema.tags[0].name).toBe('Introduction');
      expect(schema.tags[1].name).toBe('Methods');
      expect(schema.tags[2].name).toBe('Results');
      expect(schema.tags[3].name).toBe('Discussion');
    });

    it('should have Introduction tag with examples', () => {
      const introTag = schema.tags.find(t => t.name === 'Introduction');

      expect(introTag).toBeDefined();
      expect(introTag!.description).toBe('Background, context, and research question');
      expect(introTag!.examples).toContain('What is the research question?');
    });

    it('should have Methods tag with examples', () => {
      const methodsTag = schema.tags.find(t => t.name === 'Methods');

      expect(methodsTag).toBeDefined();
      expect(methodsTag!.description).toBe('Experimental design and procedures');
      expect(methodsTag!.examples).toContain('How was the study conducted?');
    });

    it('should have Results tag with examples', () => {
      const resultsTag = schema.tags.find(t => t.name === 'Results');

      expect(resultsTag).toBeDefined();
      expect(resultsTag!.description).toBe('Findings and observations');
      expect(resultsTag!.examples).toContain('What did the study find?');
    });

    it('should have Discussion tag with examples', () => {
      const discussionTag = schema.tags.find(t => t.name === 'Discussion');

      expect(discussionTag).toBeDefined();
      expect(discussionTag!.description).toBe('Interpretation and implications of results');
      expect(discussionTag!.examples).toContain('What do the results mean?');
    });
  });

  describe('Argument Toulmin Schema', () => {
    const schema = TAG_SCHEMAS['argument-toulmin'];

    it('should have correct metadata', () => {
      expect(schema.id).toBe('argument-toulmin');
      expect(schema.name).toBe('Argument Structure (Toulmin)');
      expect(schema.description).toBe('Claim, Evidence, Warrant, Counterargument, Rebuttal framework for argumentation');
      expect(schema.domain).toBe('general');
    });

    it('should have Toulmin tags in order', () => {
      expect(schema.tags).toHaveLength(5);
      expect(schema.tags[0].name).toBe('Claim');
      expect(schema.tags[1].name).toBe('Evidence');
      expect(schema.tags[2].name).toBe('Warrant');
      expect(schema.tags[3].name).toBe('Counterargument');
      expect(schema.tags[4].name).toBe('Rebuttal');
    });

    it('should have Claim tag with examples', () => {
      const claimTag = schema.tags.find(t => t.name === 'Claim');

      expect(claimTag).toBeDefined();
      expect(claimTag!.description).toBe('The main assertion or thesis');
      expect(claimTag!.examples).toContain('What is being argued?');
    });

    it('should have Evidence tag with examples', () => {
      const evidenceTag = schema.tags.find(t => t.name === 'Evidence');

      expect(evidenceTag).toBeDefined();
      expect(evidenceTag!.description).toBe('Data or facts supporting the claim');
      expect(evidenceTag!.examples).toContain('What supports this claim?');
    });

    it('should have Warrant tag with examples', () => {
      const warrantTag = schema.tags.find(t => t.name === 'Warrant');

      expect(warrantTag).toBeDefined();
      expect(warrantTag!.description).toBe('Reasoning connecting evidence to claim');
      expect(warrantTag!.examples).toContain('Why does this evidence support the claim?');
    });

    it('should have Counterargument tag with examples', () => {
      const counterTag = schema.tags.find(t => t.name === 'Counterargument');

      expect(counterTag).toBeDefined();
      expect(counterTag!.description).toBe('Opposing viewpoints or objections');
      expect(counterTag!.examples).toContain('What are the objections?');
    });

    it('should have Rebuttal tag with examples', () => {
      const rebuttalTag = schema.tags.find(t => t.name === 'Rebuttal');

      expect(rebuttalTag).toBeDefined();
      expect(rebuttalTag!.description).toBe('Response to counterarguments');
      expect(rebuttalTag!.examples).toContain('How is the objection addressed?');
    });
  });
});

describe('getTagSchema', () => {
  describe('Valid Schema IDs', () => {
    it('should return legal-irac schema', () => {
      const schema = getTagSchema('legal-irac');

      expect(schema).not.toBeNull();
      expect(schema!.id).toBe('legal-irac');
      expect(schema!.domain).toBe('legal');
    });

    it('should return scientific-imrad schema', () => {
      const schema = getTagSchema('scientific-imrad');

      expect(schema).not.toBeNull();
      expect(schema!.id).toBe('scientific-imrad');
      expect(schema!.domain).toBe('scientific');
    });

    it('should return argument-toulmin schema', () => {
      const schema = getTagSchema('argument-toulmin');

      expect(schema).not.toBeNull();
      expect(schema!.id).toBe('argument-toulmin');
      expect(schema!.domain).toBe('general');
    });
  });

  describe('Invalid Schema IDs', () => {
    it('should return null for non-existent schema', () => {
      const schema = getTagSchema('non-existent');

      expect(schema).toBeNull();
    });

    it('should return null for empty string', () => {
      const schema = getTagSchema('');

      expect(schema).toBeNull();
    });

    it('should return null for partial match', () => {
      const schema = getTagSchema('legal');

      expect(schema).toBeNull();
    });

    it('should return null for case mismatch', () => {
      const schema = getTagSchema('Legal-IRAC');

      expect(schema).toBeNull();
    });
  });
});

describe('getAllTagSchemas', () => {
  it('should return all schemas', () => {
    const schemas = getAllTagSchemas();

    expect(schemas).toHaveLength(3);
  });

  it('should return schemas as array', () => {
    const schemas = getAllTagSchemas();

    expect(Array.isArray(schemas)).toBe(true);
  });

  it('should return all expected schemas', () => {
    const schemas = getAllTagSchemas();
    const ids = schemas.map(s => s.id);

    expect(ids).toContain('legal-irac');
    expect(ids).toContain('scientific-imrad');
    expect(ids).toContain('argument-toulmin');
  });

  it('should return schemas with all properties', () => {
    const schemas = getAllTagSchemas();

    schemas.forEach(schema => {
      expect(schema).toHaveProperty('id');
      expect(schema).toHaveProperty('name');
      expect(schema).toHaveProperty('description');
      expect(schema).toHaveProperty('domain');
      expect(schema).toHaveProperty('tags');
    });
  });
});

describe('getTagSchemasByDomain', () => {
  describe('Legal Domain', () => {
    it('should return only legal schemas', () => {
      const schemas = getTagSchemasByDomain('legal');

      expect(schemas).toHaveLength(1);
      expect(schemas[0].id).toBe('legal-irac');
      expect(schemas[0].domain).toBe('legal');
    });
  });

  describe('Scientific Domain', () => {
    it('should return only scientific schemas', () => {
      const schemas = getTagSchemasByDomain('scientific');

      expect(schemas).toHaveLength(1);
      expect(schemas[0].id).toBe('scientific-imrad');
      expect(schemas[0].domain).toBe('scientific');
    });
  });

  describe('General Domain', () => {
    it('should return only general schemas', () => {
      const schemas = getTagSchemasByDomain('general');

      expect(schemas).toHaveLength(1);
      expect(schemas[0].id).toBe('argument-toulmin');
      expect(schemas[0].domain).toBe('general');
    });
  });

  describe('Empty Results', () => {
    it('should return empty array for non-existent domain', () => {
      // @ts-expect-error Testing invalid domain
      const schemas = getTagSchemasByDomain('non-existent');

      expect(schemas).toHaveLength(0);
      expect(Array.isArray(schemas)).toBe(true);
    });
  });

  describe('Return Type', () => {
    it('should return array of schemas', () => {
      const schemas = getTagSchemasByDomain('legal');

      expect(Array.isArray(schemas)).toBe(true);
      schemas.forEach(schema => {
        expect(schema).toHaveProperty('id');
        expect(schema).toHaveProperty('tags');
      });
    });
  });
});

describe('isValidCategory', () => {
  describe('Valid Categories', () => {
    it('should return true for valid IRAC categories', () => {
      expect(isValidCategory('legal-irac', 'Issue')).toBe(true);
      expect(isValidCategory('legal-irac', 'Rule')).toBe(true);
      expect(isValidCategory('legal-irac', 'Application')).toBe(true);
      expect(isValidCategory('legal-irac', 'Conclusion')).toBe(true);
    });

    it('should return true for valid IMRAD categories', () => {
      expect(isValidCategory('scientific-imrad', 'Introduction')).toBe(true);
      expect(isValidCategory('scientific-imrad', 'Methods')).toBe(true);
      expect(isValidCategory('scientific-imrad', 'Results')).toBe(true);
      expect(isValidCategory('scientific-imrad', 'Discussion')).toBe(true);
    });

    it('should return true for valid Toulmin categories', () => {
      expect(isValidCategory('argument-toulmin', 'Claim')).toBe(true);
      expect(isValidCategory('argument-toulmin', 'Evidence')).toBe(true);
      expect(isValidCategory('argument-toulmin', 'Warrant')).toBe(true);
      expect(isValidCategory('argument-toulmin', 'Counterargument')).toBe(true);
      expect(isValidCategory('argument-toulmin', 'Rebuttal')).toBe(true);
    });
  });

  describe('Invalid Categories', () => {
    it('should return false for non-existent schema', () => {
      expect(isValidCategory('non-existent', 'Issue')).toBe(false);
    });

    it('should return false for invalid category name', () => {
      expect(isValidCategory('legal-irac', 'InvalidCategory')).toBe(false);
    });

    it('should return false for empty category name', () => {
      expect(isValidCategory('legal-irac', '')).toBe(false);
    });

    it('should return false for category from different schema', () => {
      expect(isValidCategory('legal-irac', 'Introduction')).toBe(false);
      expect(isValidCategory('scientific-imrad', 'Issue')).toBe(false);
      expect(isValidCategory('argument-toulmin', 'Rule')).toBe(false);
    });

    it('should return false for case mismatch', () => {
      expect(isValidCategory('legal-irac', 'issue')).toBe(false);
      expect(isValidCategory('legal-irac', 'ISSUE')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty schema ID', () => {
      expect(isValidCategory('', 'Issue')).toBe(false);
    });

    it('should handle both empty parameters', () => {
      expect(isValidCategory('', '')).toBe(false);
    });
  });
});

describe('getTagCategory', () => {
  describe('Valid Categories', () => {
    it('should return Issue category from legal-irac', () => {
      const category = getTagCategory('legal-irac', 'Issue');

      expect(category).not.toBeNull();
      expect(category!.name).toBe('Issue');
      expect(category!.description).toBe('The legal question or problem to be resolved');
      expect(category!.examples).toContain('What is the central legal question?');
    });

    it('should return Rule category from legal-irac', () => {
      const category = getTagCategory('legal-irac', 'Rule');

      expect(category).not.toBeNull();
      expect(category!.name).toBe('Rule');
      expect(category!.description).toBe('The relevant law, statute, or legal principle');
    });

    it('should return Introduction category from scientific-imrad', () => {
      const category = getTagCategory('scientific-imrad', 'Introduction');

      expect(category).not.toBeNull();
      expect(category!.name).toBe('Introduction');
      expect(category!.description).toBe('Background, context, and research question');
    });

    it('should return Claim category from argument-toulmin', () => {
      const category = getTagCategory('argument-toulmin', 'Claim');

      expect(category).not.toBeNull();
      expect(category!.name).toBe('Claim');
      expect(category!.description).toBe('The main assertion or thesis');
    });
  });

  describe('Invalid Categories', () => {
    it('should return null for non-existent schema', () => {
      const category = getTagCategory('non-existent', 'Issue');

      expect(category).toBeNull();
    });

    it('should return null for invalid category name', () => {
      const category = getTagCategory('legal-irac', 'InvalidCategory');

      expect(category).toBeNull();
    });

    it('should return null for empty category name', () => {
      const category = getTagCategory('legal-irac', '');

      expect(category).toBeNull();
    });

    it('should return null for category from different schema', () => {
      const category = getTagCategory('legal-irac', 'Introduction');

      expect(category).toBeNull();
    });

    it('should return null for case mismatch', () => {
      const category = getTagCategory('legal-irac', 'issue');

      expect(category).toBeNull();
    });
  });

  describe('Return Value Structure', () => {
    it('should return category with all properties', () => {
      const category = getTagCategory('legal-irac', 'Issue');

      expect(category).toHaveProperty('name');
      expect(category).toHaveProperty('description');
      expect(category).toHaveProperty('examples');
      expect(Array.isArray(category!.examples)).toBe(true);
    });

    it('should return complete category data', () => {
      const category = getTagCategory('argument-toulmin', 'Rebuttal');

      expect(category!.name).toBe('Rebuttal');
      expect(category!.description).toBeTruthy();
      expect(category!.examples.length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty schema ID', () => {
      const category = getTagCategory('', 'Issue');

      expect(category).toBeNull();
    });

    it('should handle both empty parameters', () => {
      const category = getTagCategory('', '');

      expect(category).toBeNull();
    });
  });
});

describe('Data Integrity', () => {
  describe('No Duplicate Categories', () => {
    it('should not have duplicate category names within legal-irac', () => {
      const schema = TAG_SCHEMAS['legal-irac'];
      const names = schema.tags.map(t => t.name);
      const uniqueNames = new Set(names);

      expect(names.length).toBe(uniqueNames.size);
    });

    it('should not have duplicate category names within scientific-imrad', () => {
      const schema = TAG_SCHEMAS['scientific-imrad'];
      const names = schema.tags.map(t => t.name);
      const uniqueNames = new Set(names);

      expect(names.length).toBe(uniqueNames.size);
    });

    it('should not have duplicate category names within argument-toulmin', () => {
      const schema = TAG_SCHEMAS['argument-toulmin'];
      const names = schema.tags.map(t => t.name);
      const uniqueNames = new Set(names);

      expect(names.length).toBe(uniqueNames.size);
    });
  });

  describe('Non-Empty Strings', () => {
    it('should have non-empty names and descriptions', () => {
      Object.values(TAG_SCHEMAS).forEach(schema => {
        expect(schema.name.length).toBeGreaterThan(0);
        expect(schema.description.length).toBeGreaterThan(0);

        schema.tags.forEach(tag => {
          expect(tag.name.length).toBeGreaterThan(0);
          expect(tag.description.length).toBeGreaterThan(0);
        });
      });
    });

    it('should have non-empty examples', () => {
      Object.values(TAG_SCHEMAS).forEach(schema => {
        schema.tags.forEach(tag => {
          tag.examples.forEach(example => {
            expect(example.length).toBeGreaterThan(0);
          });
        });
      });
    });
  });

  describe('Consistent Structure', () => {
    it('should have all schemas with same structure', () => {
      const schemas = Object.values(TAG_SCHEMAS);

      schemas.forEach(schema => {
        expect(typeof schema.id).toBe('string');
        expect(typeof schema.name).toBe('string');
        expect(typeof schema.description).toBe('string');
        expect(['legal', 'scientific', 'general']).toContain(schema.domain);
        expect(Array.isArray(schema.tags)).toBe(true);
      });
    });

    it('should have all tags with same structure', () => {
      Object.values(TAG_SCHEMAS).forEach(schema => {
        schema.tags.forEach(tag => {
          expect(typeof tag.name).toBe('string');
          expect(typeof tag.description).toBe('string');
          expect(Array.isArray(tag.examples)).toBe(true);
        });
      });
    });
  });
});
