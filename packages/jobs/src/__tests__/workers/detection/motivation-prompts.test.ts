/**
 * Motivation Prompts Tests
 *
 * Tests the MotivationPrompts class which builds AI prompts for different
 * annotation motivations (commenting, highlighting, assessing, tagging).
 */

import { describe, it, expect } from 'vitest';
import { MotivationPrompts } from '../../../workers/detection/motivation-prompts';

describe('MotivationPrompts', () => {
  const testContent = 'This is sample text content for testing prompt generation.';

  describe('buildCommentPrompt', () => {
    it('should build basic prompt without parameters', () => {
      const prompt = MotivationPrompts.buildCommentPrompt(testContent);

      expect(prompt).toContain('explanatory comments');
      expect(prompt).toContain(testContent);
      expect(prompt).toContain('JSON array');
      expect(prompt).toContain('exact');
      expect(prompt).toContain('start');
      expect(prompt).toContain('end');
    });

    it('should include custom instructions when provided', () => {
      const instructions = 'Focus on technical concepts';
      const prompt = MotivationPrompts.buildCommentPrompt(testContent, instructions);

      expect(prompt).toContain(instructions);
      expect(prompt).toContain(testContent);
    });

    it('should include tone guidance when provided', () => {
      const prompt = MotivationPrompts.buildCommentPrompt(testContent, undefined, 'scholarly');

      expect(prompt).toContain('scholarly');
    });

    it('should include density guidance when provided', () => {
      const prompt = MotivationPrompts.buildCommentPrompt(testContent, undefined, undefined, 8);

      expect(prompt).toContain('8 comments per 2000 words');
    });

    it('should include both tone and density', () => {
      const prompt = MotivationPrompts.buildCommentPrompt(testContent, undefined, 'conversational', 5);

      expect(prompt).toContain('conversational');
      expect(prompt).toContain('5 comments per 2000 words');
    });

    it('should truncate content to 8000 characters', () => {
      const longContent = 'x'.repeat(10000);
      const prompt = MotivationPrompts.buildCommentPrompt(longContent);

      expect(prompt).toContain('x'.repeat(8000));
      expect(prompt).not.toContain('x'.repeat(8001));
    });

    it('should use different mode with custom instructions', () => {
      const withInstructions = MotivationPrompts.buildCommentPrompt(testContent, 'Test instructions');
      const withoutInstructions = MotivationPrompts.buildCommentPrompt(testContent);

      expect(withInstructions).toContain('following these instructions');
      expect(withoutInstructions).toContain('explanatory');
      expect(withInstructions).not.toEqual(withoutInstructions);
    });
  });

  describe('buildHighlightPrompt', () => {
    it('should build basic prompt without parameters', () => {
      const prompt = MotivationPrompts.buildHighlightPrompt(testContent);

      expect(prompt).toContain('highlight');
      expect(prompt).toContain(testContent);
      expect(prompt).toContain('JSON array');
      expect(prompt).toContain('importance');
    });

    it('should include custom instructions when provided', () => {
      const instructions = 'Highlight key findings';
      const prompt = MotivationPrompts.buildHighlightPrompt(testContent, instructions);

      expect(prompt).toContain(instructions);
    });

    it('should include density guidance when provided', () => {
      const prompt = MotivationPrompts.buildHighlightPrompt(testContent, undefined, 6);

      expect(prompt).toContain('6 highlights per 2000 words');
    });

    it('should truncate content to 8000 characters', () => {
      const longContent = 'y'.repeat(10000);
      const prompt = MotivationPrompts.buildHighlightPrompt(longContent);

      expect(prompt).toContain('y'.repeat(8000));
      expect(prompt).not.toContain('y'.repeat(8001));
    });

    it('should use different mode with custom instructions', () => {
      const withInstructions = MotivationPrompts.buildHighlightPrompt(testContent, 'Test instructions');
      const withoutInstructions = MotivationPrompts.buildHighlightPrompt(testContent);

      expect(withInstructions).toContain('following these instructions');
      expect(withoutInstructions).toContain('importance or salience');
      expect(withInstructions).not.toEqual(withoutInstructions);
    });
  });

  describe('buildAssessmentPrompt', () => {
    it('should build basic prompt without parameters', () => {
      const prompt = MotivationPrompts.buildAssessmentPrompt(testContent);

      expect(prompt).toContain('assessment');
      expect(prompt).toContain(testContent);
      expect(prompt).toContain('JSON array');
      expect(prompt).toContain('evaluation');
    });

    it('should include custom instructions when provided', () => {
      const instructions = 'Assess validity of claims';
      const prompt = MotivationPrompts.buildAssessmentPrompt(testContent, instructions);

      expect(prompt).toContain(instructions);
    });

    it('should include tone guidance when provided', () => {
      const prompt = MotivationPrompts.buildAssessmentPrompt(testContent, undefined, 'critical');

      expect(prompt).toContain('critical');
    });

    it('should include density guidance when provided', () => {
      const prompt = MotivationPrompts.buildAssessmentPrompt(testContent, undefined, undefined, 4);

      expect(prompt).toContain('4 assessments per 2000 words');
    });

    it('should truncate content to 8000 characters', () => {
      const longContent = 'z'.repeat(10000);
      const prompt = MotivationPrompts.buildAssessmentPrompt(longContent);

      expect(prompt).toContain('z'.repeat(8000));
      expect(prompt).not.toContain('z'.repeat(8001));
    });
  });

  describe('buildTagPrompt', () => {
    it('should build structural tag prompt with all parameters', () => {
      const prompt = MotivationPrompts.buildTagPrompt(
        testContent,
        'Issue',
        'IRAC',
        'Issue, Rule, Application, Conclusion framework for legal analysis',
        'Legal Writing',
        'Identifies the legal question or problem to be resolved',
        ['What is the central legal question?', 'What must be decided?']
      );

      expect(prompt).toContain('IRAC');
      expect(prompt).toContain('Issue');
      expect(prompt).toContain('legal question');
      expect(prompt).toContain('What is the central legal question?');
      expect(prompt).toContain('What must be decided?');
      expect(prompt).toContain(testContent);
    });

    it('should not truncate content for structural analysis', () => {
      const longContent = 'a'.repeat(10000);
      const prompt = MotivationPrompts.buildTagPrompt(
        longContent,
        'Methods',
        'IMRAD',
        'Introduction, Methods, Results, and Discussion scientific paper structure',
        'Scientific Writing',
        'Describes research methodology',
        ['How was the study conducted?']
      );

      // Should include full content for structural analysis
      expect(prompt).toContain('a'.repeat(10000));
    });

    it('should format examples as bullet points', () => {
      const prompt = MotivationPrompts.buildTagPrompt(
        testContent,
        'Conclusion',
        'Toulmin',
        'Toulmin model of argumentation',
        'Critical Thinking',
        'Main argument or claim',
        ['What is being argued?', 'What is the main claim?', 'What position is taken?']
      );

      expect(prompt).toContain('- What is being argued?');
      expect(prompt).toContain('- What is the main claim?');
      expect(prompt).toContain('- What position is taken?');
    });

    it('should emphasize structural function', () => {
      const prompt = MotivationPrompts.buildTagPrompt(
        testContent,
        'Methods',
        'IMRAD',
        'Scientific paper structure',
        'Scientific Writing',
        'Research methodology',
        ['How was it done?']
      );

      expect(prompt).toContain('STRUCTURAL FUNCTION');
      expect(prompt).toContain('structural role');
    });

    it('should include all schema context', () => {
      const schemaName = 'TestSchema';
      const schemaDescription = 'Test schema description';
      const schemaDomain = 'Test domain';
      const prompt = MotivationPrompts.buildTagPrompt(
        testContent,
        'Category',
        schemaName,
        schemaDescription,
        schemaDomain,
        'Category description',
        ['Example question']
      );

      expect(prompt).toContain(schemaName);
      expect(prompt).toContain(schemaDescription);
      expect(prompt).toContain(schemaDomain);
    });
  });

  describe('locale handling', () => {
    // Two independent locales flow through detection prompts:
    //   - `language` — annotation body locale (where the LLM should write)
    //   - `sourceLanguage` — source-resource locale (what the LLM is reading)
    // These tests pin the contract: each is wired to its own field, and they
    // don't bleed into each other.

    describe('source language (always wired)', () => {
      it('builds comment prompt with source-language guidance when set', () => {
        const prompt = MotivationPrompts.buildCommentPrompt(
          testContent, undefined, undefined, undefined, undefined, 'fr',
        );
        expect(prompt).toContain('Source text language: French');
      });

      it('builds highlight prompt with source-language guidance when set', () => {
        const prompt = MotivationPrompts.buildHighlightPrompt(
          testContent, undefined, undefined, 'es',
        );
        expect(prompt).toContain('Source text language: Spanish');
      });

      it('builds assessment prompt with source-language guidance when set', () => {
        const prompt = MotivationPrompts.buildAssessmentPrompt(
          testContent, undefined, undefined, undefined, undefined, 'de',
        );
        expect(prompt).toContain('Source text language: German');
      });

      it('builds tag prompt with source-language guidance when set', () => {
        const prompt = MotivationPrompts.buildTagPrompt(
          testContent, 'Category', 'Schema', 'Description', 'Domain',
          'Category description', ['Example'], 'ja',
        );
        expect(prompt).toContain('Source text language: Japanese');
      });

      it('omits source-language guidance when unset', () => {
        const prompt = MotivationPrompts.buildCommentPrompt(testContent);
        expect(prompt).not.toContain('Source text language:');
      });

      it('falls back to the raw tag when the BCP-47 code is unknown', () => {
        const prompt = MotivationPrompts.buildHighlightPrompt(
          testContent, undefined, undefined, 'xx',
        );
        expect(prompt).toContain('Source text language: xx');
      });
    });

    describe('body language (comments and assessments only)', () => {
      it('builds comment prompt with body-language guidance when set to non-en', () => {
        const prompt = MotivationPrompts.buildCommentPrompt(
          testContent, undefined, undefined, undefined, 'fr',
        );
        expect(prompt).toContain('Write your comments in French');
      });

      it('builds assessment prompt with body-language guidance when set to non-en', () => {
        const prompt = MotivationPrompts.buildAssessmentPrompt(
          testContent, undefined, undefined, undefined, 'es',
        );
        expect(prompt).toContain('Write your assessments in Spanish');
      });

      it('omits body-language guidance when language is en', () => {
        // English is the LLM's default; an explicit "Write in English" line
        // is noise that crowds out other instructions.
        const prompt = MotivationPrompts.buildCommentPrompt(
          testContent, undefined, undefined, undefined, 'en',
        );
        expect(prompt).not.toContain('Write your comments in');
      });

      it('omits body-language guidance when language is unset', () => {
        const prompt = MotivationPrompts.buildAssessmentPrompt(testContent);
        expect(prompt).not.toContain('Write your assessments in');
      });

      it('honors body-language guidance in the instruction-driven branch too', () => {
        // The non-instruction and instruction branches build different
        // prompts — both must wire body-language guidance.
        const prompt = MotivationPrompts.buildCommentPrompt(
          testContent, 'Be brief', undefined, undefined, 'de',
        );
        expect(prompt).toContain('Write your comments in German');
        expect(prompt).toContain('Be brief');
      });
    });

    describe('tags do not get body-language guidance', () => {
      // Tag categories are schema-defined identifiers, not LLM-generated
      // text. Body locale for tags is consumed at the body-stamp site, not
      // here — the tag prompt builder doesn't even take a `language` arg.
      it('does not contain body-language guidance regardless of source-language', () => {
        const prompt = MotivationPrompts.buildTagPrompt(
          testContent, 'Issue', 'IRAC', 'Legal reasoning', 'Law',
          'The legal question', ['What is the issue?'], 'fr',
        );
        expect(prompt).not.toContain('Write your');
      });
    });

    describe('locales are independent', () => {
      it('different body and source locales coexist without bleeding', () => {
        const prompt = MotivationPrompts.buildCommentPrompt(
          testContent, undefined, undefined, undefined, 'de', 'fr',
        );
        expect(prompt).toContain('Source text language: French');
        expect(prompt).toContain('Write your comments in German');
      });
    });
  });
});
