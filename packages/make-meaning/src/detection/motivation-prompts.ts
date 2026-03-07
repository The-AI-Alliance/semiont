/**
 * Prompt builders for annotation detection motivations
 *
 * Provides static methods to build AI prompts for each Web Annotation motivation type.
 * Extracted from worker implementations to centralize prompt logic.
 */

export class MotivationPrompts {
  /**
   * Build a prompt for detecting comment-worthy passages
   *
   * @param content - The text content to analyze (will be truncated to 8000 chars)
   * @param instructions - Optional user-provided instructions
   * @param tone - Optional tone guidance (e.g., "academic", "conversational")
   * @param density - Optional target number of comments per 2000 words
   * @returns Formatted prompt string
   */
  static buildCommentPrompt(
    content: string,
    instructions?: string,
    tone?: string,
    density?: number
  ): string {
    let prompt: string;

    if (instructions) {
      // User provided specific instructions - minimal prompt, let instructions drive behavior
      const toneGuidance = tone ? ` Use a ${tone} tone.` : '';
      const densityGuidance = density
        ? `\n\nAim for approximately ${density} comments per 2000 words of text.`
        : ''; // Let user instructions determine density

      prompt = `Add comments to passages in this text following these instructions:

${instructions}${toneGuidance}${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of comments. Each comment must have:
- "exact": the exact text passage being commented on (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage
- "comment": your comment following the instructions above

Return ONLY a valid JSON array, no additional text or explanation.

Example:
[
  {"exact": "the quarterly review meeting", "start": 142, "end": 169, "prefix": "We need to schedule ", "suffix": " for next month.", "comment": "Who will lead this? Should we invite the external auditors?"}
]`;
    } else {
      // No specific instructions - fall back to explanatory/educational mode
      const toneGuidance = tone
        ? `\n\nTone: Use a ${tone} style in your comments.`
        : '';
      const densityGuidance = density
        ? `\n- Aim for approximately ${density} comments per 2000 words`
        : `\n- Aim for 3-8 comments per 2000 words (not too sparse or dense)`;

      prompt = `Identify passages in this text that would benefit from explanatory comments.
For each passage, provide contextual information, clarification, or background.${toneGuidance}

Guidelines:
- Select passages that reference technical terms, historical figures, complex concepts, or unclear references
- Provide comments that ADD VALUE beyond restating the text
- Focus on explanation, background, or connections to other ideas
- Avoid obvious or trivial comments
- Keep comments concise (1-3 sentences typically)${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of comments. Each comment should have:
- "exact": the exact text passage being commented on (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage
- "comment": your explanatory comment (1-3 sentences, provide context/background/clarification)

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {"exact": "Ouranos", "start": 52, "end": 59, "prefix": "In the beginning, ", "suffix": " ruled the universe", "comment": "Ouranos (also spelled Uranus) is the primordial Greek deity personifying the sky. In Hesiod's Theogony, he is the son and husband of Gaia (Earth) and father of the Titans."}
]`;
    }

    return prompt;
  }

  /**
   * Build a prompt for detecting highlight-worthy passages
   *
   * @param content - The text content to analyze (will be truncated to 8000 chars)
   * @param instructions - Optional user-provided instructions
   * @param density - Optional target number of highlights per 2000 words
   * @returns Formatted prompt string
   */
  static buildHighlightPrompt(
    content: string,
    instructions?: string,
    density?: number
  ): string {
    let prompt: string;

    if (instructions) {
      // User provided specific instructions - minimal prompt, let instructions drive behavior
      const densityGuidance = density
        ? `\n\nAim for approximately ${density} highlights per 2000 words of text.`
        : ''; // Let user instructions determine density

      prompt = `Identify passages in this text to highlight following these instructions:

${instructions}${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of highlights. Each highlight must have:
- "exact": the exact text passage to highlight (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage

Return ONLY a valid JSON array, no additional text or explanation.

Example:
[
  {"exact": "revenue grew 45% year-over-year", "start": 142, "end": 174, "prefix": "In Q3 2024, ", "suffix": ", exceeding all forecasts."}
]`;
    } else {
      // No specific instructions - fall back to importance/salience mode
      const densityGuidance = density
        ? `\n- Aim for approximately ${density} highlights per 2000 words`
        : `\n- Aim for 3-8 highlights per 2000 words (be selective)`;

      prompt = `Identify passages in this text that merit highlighting for their importance or salience.
Focus on content that readers should notice and remember.

Guidelines:
- Highlight key claims, findings, or conclusions
- Highlight important definitions, terminology, or concepts
- Highlight notable quotes or particularly striking statements
- Highlight critical decisions, action items, or turning points
- Select passages that are SIGNIFICANT, not just interesting
- Avoid trivial or obvious content${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of highlights. Each highlight should have:
- "exact": the exact text passage to highlight (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {"exact": "we will discontinue support for legacy systems by March 2025", "start": 52, "end": 113, "prefix": "After careful consideration, ", "suffix": ". This decision affects"}
]`;
    }

    return prompt;
  }

  /**
   * Build a prompt for detecting assessment-worthy passages
   *
   * @param content - The text content to analyze (will be truncated to 8000 chars)
   * @param instructions - Optional user-provided instructions
   * @param tone - Optional tone guidance (e.g., "critical", "supportive")
   * @param density - Optional target number of assessments per 2000 words
   * @returns Formatted prompt string
   */
  static buildAssessmentPrompt(
    content: string,
    instructions?: string,
    tone?: string,
    density?: number
  ): string {
    let prompt: string;

    if (instructions) {
      // User provided specific instructions - minimal prompt, let instructions drive behavior
      const toneGuidance = tone ? ` Use a ${tone} tone.` : '';
      const densityGuidance = density
        ? `\n\nAim for approximately ${density} assessments per 2000 words of text.`
        : ''; // Let user instructions determine density

      prompt = `Assess passages in this text following these instructions:

${instructions}${toneGuidance}${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of assessments. Each assessment must have:
- "exact": the exact text passage being assessed (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage
- "assessment": your assessment following the instructions above

Return ONLY a valid JSON array, no additional text or explanation.

Example:
[
  {"exact": "the quarterly revenue target", "start": 142, "end": 169, "prefix": "We established ", "suffix": " for Q4 2024.", "assessment": "This target seems ambitious given market conditions. Consider revising based on recent trends."}
]`;
    } else {
      // No specific instructions - fall back to analytical/evaluation mode
      const toneGuidance = tone
        ? `\n\nTone: Use a ${tone} style in your assessments.`
        : '';
      const densityGuidance = density
        ? `\n- Aim for approximately ${density} assessments per 2000 words`
        : `\n- Aim for 2-6 assessments per 2000 words (focus on key passages)`;

      prompt = `Identify passages in this text that merit critical assessment or evaluation.
For each passage, provide analysis of its validity, strength, or implications.${toneGuidance}

Guidelines:
- Select passages containing claims, arguments, conclusions, or assertions
- Assess evidence quality, logical soundness, or practical implications
- Provide assessments that ADD INSIGHT beyond restating the text
- Focus on passages where evaluation would help readers form judgments
- Keep assessments concise yet substantive (1-3 sentences typically)${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of assessments. Each assessment should have:
- "exact": the exact text passage being assessed (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage
- "assessment": your analytical assessment (1-3 sentences, evaluate validity/strength/implications)

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {"exact": "AI will replace most jobs by 2030", "start": 52, "end": 89, "prefix": "Many experts predict that ", "suffix": ", fundamentally reshaping", "assessment": "This claim lacks nuance and supporting evidence. Employment patterns historically show job transformation rather than wholesale replacement. The timeline appears speculative without specific sector analysis."}
]`;
    }

    return prompt;
  }

  /**
   * Build a prompt for detecting structural tags
   *
   * @param content - The full text content to analyze (NOT truncated for structural analysis)
   * @param category - The specific category to detect
   * @param schemaName - Human-readable schema name
   * @param schemaDescription - Schema description
   * @param schemaDomain - Schema domain
   * @param categoryDescription - Category description
   * @param categoryExamples - Example questions/guidance for this category
   * @returns Formatted prompt string
   */
  static buildTagPrompt(
    content: string,
    category: string,
    schemaName: string,
    schemaDescription: string,
    schemaDomain: string,
    categoryDescription: string,
    categoryExamples: string[]
  ): string {
    // Build prompt with schema context and category-specific guidance
    const prompt = `You are analyzing a text using the ${schemaName} framework.

Schema: ${schemaDescription}
Domain: ${schemaDomain}

Your task: Identify passages that serve the structural role of "${category}".

Category: ${category}
Description: ${categoryDescription}
Key questions:
${categoryExamples.map(ex => `- ${ex}`).join('\n')}

Guidelines:
- Focus on STRUCTURAL FUNCTION, not semantic content
- A passage serves the "${category}" role if it performs this function in the document's structure
- Look for passages that explicitly fulfill this role
- Passages can be sentences, paragraphs, or sections
- Aim for precision - only tag passages that clearly serve this structural role
- Typical documents have 1-5 instances of each category (some may have 0)

Text to analyze:
---
${content}
---

Return a JSON array of tags. Each tag should have:
- "exact": the exact text passage (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {"exact": "What duty did the defendant owe?", "start": 142, "end": 175, "prefix": "The central question is: ", "suffix": " This question must be"},
  {"exact": "In tort law, a duty of care is established when...", "start": 412, "end": 520, "prefix": "Legal framework:\\n", "suffix": "\\n\\nApplying this standard"}
]`;

    return prompt;
  }
}
