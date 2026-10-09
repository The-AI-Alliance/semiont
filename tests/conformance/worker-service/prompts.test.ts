/**
 * The other ways each kind of `mark` job is asked (WORKER-SERVICE.md § The
 * five kinds of mark job): what a job's instructions, tone, density and
 * languages, or the lack of each, make of the prompt its model is sent. The
 * prompts are the files beside this one, in `prompts/`.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, FORMATS, generation, identity, markJob, settled } from './support';

/** The schema a tagging job is handed with: the one `tagging.test.ts` uses. */
const SCHEMA = {
  id: 'argument',
  name: 'Argument',
  description: 'What a text claims and what it offers in support',
  domain: 'rhetoric',
  tags: [
    { name: 'Claim', description: 'What the text asserts', examples: ['What is being asserted?'] },
    { name: 'Evidence', description: 'What supports the assertion', examples: ['What supports it?', 'Is a source given?'] },
  ],
};

/** Each: the prompt's file, the job's parameters, the request's token budget and window, and what the answer is to be an array of. */
const ASKED: Array<[string, Record<string, unknown>, { num_predict: number; num_ctx: number }, keyof typeof FORMATS]> = [
  ['highlighting-dense', { motivation: 'highlighting', density: 5, sourceLanguage: 'de' }, { num_predict: 5279, num_ctx: 5789 }, 'highlighting'],
  ['commenting-plain', { motivation: 'commenting' }, { num_predict: 5246, num_ctx: 5816 }, 'commenting'],
  ['commenting-toned', { motivation: 'commenting', tone: 'conversational', density: 6, language: 'de', sourceLanguage: 'fr' }, { num_predict: 5228, num_ctx: 5831 }, 'commenting'],
  ['assessing-plain', { motivation: 'assessing' }, { num_predict: 5227, num_ctx: 5830 }, 'assessing'],
  ['assessing-instructed', { motivation: 'assessing', instructions: 'Judge the evidence.', tone: 'balanced', density: 3, language: 'ja', sourceLanguage: 'en' }, { num_predict: 5315, num_ctx: 5760 }, 'assessing'],
  ['tagging-language', { motivation: 'tagging', schemaId: SCHEMA.id, categories: ['Claim'], schema: SCHEMA, sourceLanguage: 'en' }, { num_predict: 5237, num_ctx: 5823 }, 'tagging'],
];

eachWorkerService('what a mark job asks its model', (world) => {
  it.each(ASKED)('asks %s as its file says', async (name, params, budget, kind) => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, name, params);
    w.ollama.script({ response: '[]' });
    const served = await w.start();
    const completion = await settled(served, job);

    expectGenerations(w.ollama.generations, [generation(agent.model, name, { ...budget, temperature: 0 }, FORMATS[kind])]);
    expect(completion).toMatchObject({ ...identity(job), result: { found: 0, persisted: 0 } });
  });

  it('asks a linking job that takes descriptive references for them, and counts as it does any other', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, 'linking-descriptive', { motivation: 'linking', entityTypes: ['Person'], includeDescriptiveReferences: true, sourceLanguage: 'en' });
    w.ollama.script({ response: '[]' }, { response: '0' });
    const served = await w.start();
    await settled(served, job);

    expectGenerations(w.ollama.generations, [
      generation(agent.model, 'linking-descriptive', { num_predict: 5179, num_ctx: 5869, temperature: 0 }, FORMATS.linking),
      // The count is asked of the same text, of the same types, in the same words whatever the extraction was asked.
      generation(agent.model, 'linking-person-count', { num_predict: 16, num_ctx: 244, temperature: 0 }),
    ]);
  });
});
