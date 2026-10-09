/**
 * What a job counts in a text with characters outside the Basic Multilingual
 * Plane (WORKER-SERVICE.md § The request, § Pieces, § Anchoring, § The
 * annotation, § Committing, and where a job stands, § Progress): Unicode code
 * points. Such a character is one code point, where a string of UTF-16 code
 * units has two for it, so every number a job states of such a text (a
 * piece's size, a cursor, a selector's offsets, how far through the text it
 * stands, the tokens of a prompt) tells the one count from the other.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, markJob, report, settled, SMALL_CONTEXT_LENGTH, textAnnotation, withoutCreated } from './support';

/** Characters outside the Basic Multilingual Plane. */
const COMPASS = '\u{1F9ED}'; // 🧭
const SCRIPT_C = '\u{1D49E}'; // 𝒞, a mathematical letter
const TALLY_ONE = '\u{1D377}'; // 𝍷
const TALLY_FIVE = '\u{1D378}'; // 𝍸
const SCROLL = '\u{1F4DC}'; // 📜
const BOLD_B = '\u{1D435}'; // 𝐵, a mathematical letter
const TOOLS = '\u{1F6E0}'; // 🛠

/** A text's code points, one to an element. */
const codePoints = (text: string): string[] => Array.from(text);

/**
 * A text too long for one request of a model with a small window: a
 * paragraph that ends in a tally of sixty marks, and eight paragraphs of six
 * sentences, each naming a marker no other names, with a compass in every
 * sentence. 4,140 code points, of which 110 are outside the Basic
 * Multilingual Plane: 4,250 UTF-16 code units.
 */
const SURVEY =
  `Field notes of the Rhône survey ${COMPASS}, kept by the clerk ${SCRIPT_C} of the second party. ` +
  `The clerk kept a tally of the chains measured: ${Array.from({ length: 12 }, () => TALLY_ONE.repeat(4) + TALLY_FIVE).join(' ')}.` +
  '\n\n' +
  Array.from({ length: 8 }, (_, p) =>
    Array.from({ length: 6 }, (_, s) => `Paragraph ${p + 1}, sentence ${s + 1}: the survey party ${COMPASS} recorded marker ${(p + 1) * 100 + s + 1} beside the Rhône.`).join(' '),
  ).join('\n\n') +
  '\n';

/** Two paragraphs, 317 code points, of which three are outside the Basic Multilingual Plane: 320 UTF-16 code units. */
const ENGINE =
  `${SCROLL} Ada Lovelace published the first program in 1843 — a method for computing the Bernoulli numbers ${BOLD_B} on the Analytical Engine.\n` +
  '\n' +
  `Charles Babbage ${TOOLS} designed the engine in London, but it was never built. Lovelace argued that the engine could manipulate symbols as well as numbers; nobody tested that claim for a century.\n`;

/** The size, in tokens, every piece of `SURVEY` is cut at: the provider reports no usage, so the size never moves. */
const CHUNK_SIZE = 311;

/** What stands either side of a marker's sentence in `SURVEY`. */
const before = (paragraph: number, sentence: number) => `the Rhône. Paragraph ${paragraph}, sentence ${sentence}: the survey party ${COMPASS} recorded `;
const after = (paragraph: number, sentence: number) => ` beside the Rhône. Paragraph ${paragraph}, sentence ${sentence}: the survey party ${COMPASS} recorded`;

eachWorkerService('a job over a text with characters outside the Basic Multilingual Plane', (world) => {
  it('cuts, asks, anchors, checkpoints and reports by the text\'s code points', async () => {
    const w = world();
    const agent = w.agents[0]!;
    w.ollama.show = { contextLength: SMALL_CONTEXT_LENGTH };
    const job = markJob(w, 'code-points', { motivation: 'highlighting' }, {}, SURVEY);
    const resourceId = String(job.params.resourceId);
    const marker205 = `survey party ${COMPASS} recorded marker 205`;
    w.ollama.script(
      // The first piece ends where the second paragraph of entries does. Marker 205 is in the overlap, so the second piece sees it too.
      { response: JSON.stringify([{ exact: `the clerk ${SCRIPT_C}` }, { exact: 'marker 103' }, { exact: marker205 }]) },
      { response: JSON.stringify([{ exact: marker205 }, { exact: 'marker 304', prefix: `party ${COMPASS} recorded `, suffix: ' beside' }]) },
      { response: JSON.stringify([{ exact: 'marker 502' }, { exact: `marker 999 beside the Rhône ${COMPASS} was never recorded` }]) },
      { response: JSON.stringify([{ exact: 'marker 806' }]) },
    );
    const served = await w.start();
    const completion = await settled(served, job);

    expect(codePoints(SURVEY).length).toBe(4140);
    expect(SURVEY.length).toBe(4250);

    // Four pieces, each of at most 311 tokens, which is 1,244 code points,
    // ended at a paragraph's end. Cut by UTF-16 code units the same text is
    // eight pieces: its first window would end short of the second
    // paragraph's end. The tokens of a prompt are its code points over four.
    const request = { num_predict: 622, num_ctx: SMALL_CONTEXT_LENGTH, temperature: 0 };
    expectGenerations(
      w.ollama.generations,
      ['code-points-1', 'code-points-2', 'code-points-3', 'code-points-4'].map((name) => generation(agent.model, name, request, FORMATS.highlighting)),
    );

    expect(served.sequence()).toEqual([
      'emit job:claim',
      'emit job:start',
      'emit browse:resource-requested',
      `GET /resources/${resourceId}`,
      'emit mark:commit',
      'emit job:checkpoint',
      'emit mark:commit',
      'emit job:checkpoint',
      'emit mark:commit',
      'emit job:checkpoint',
      'emit mark:commit',
      'emit job:checkpoint',
      'emit job:complete',
      'emit job:claim',
    ]);

    // A selector's offsets count code points from the start of the text, and
    // so do the 64 of a prefix and of a suffix. An id is of those offsets.
    const highlight = (id: string, at: { start: number; end: number; exact: string; prefix: string; suffix: string }) =>
      textAnnotation(w.generator(), resourceId, 'highlighting', id, at);
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        // Before it: one character outside the plane, of the 43 code points there are.
        highlight('HrGCdvWg6RJ-CgSBGphSo', {
          start: 43,
          end: 54,
          exact: `the clerk ${SCRIPT_C}`,
          prefix: `Field notes of the Rhône survey ${COMPASS}, kept by `,
          suffix: ' of the second party. The clerk kept a tally of the chains measured',
        }),
        // Before it: sixty-five. A count of UTF-16 code units would put it at 479.
        highlight('7Gw0hABVWzTOpG0l8DZKO', { start: 414, end: 424, exact: 'marker 103', prefix: before(1, 3), suffix: after(1, 4) }),
        highlight('LDef15sL7YpN2Qsjx5gS5', {
          start: 1047,
          end: 1081,
          exact: marker205,
          prefix: 'recorded marker 204 beside the Rhône. Paragraph 2, sentence 5: the ',
          suffix: after(2, 6),
        }),
      ],
      // Marker 205 was committed with the first piece: it is not committed again.
      [highlight('p63nAU8defkhsuTVHrY6K', { start: 1482, end: 1492, exact: 'marker 304', prefix: before(3, 4), suffix: after(3, 5) })],
      [highlight('humTQV3RLd7uou_gxWvu9', { start: 2304, end: 2314, exact: 'marker 502', prefix: before(5, 2), suffix: after(5, 3) })],
      // The last sentence of the text: what follows it is the text's final line end.
      [highlight('EBOSgHXfROpcBzjqbZcNm', { start: 4111, end: 4121, exact: 'marker 806', prefix: before(8, 6), suffix: ' beside the Rhône.\n' })],
    ]);
    expect(codePoints(SURVEY).slice(4111, 4121).join('')).toBe('marker 806');

    // The cursor is an offset: where the next piece starts, in code points, and
    // after the last piece the text's length in them.
    const cursor = (next: number, found: number, emitted: number, errors: number) => ({
      jobId: job.metadata.id,
      completedUnits: [],
      unitCursors: { highlighting: { next, size: CHUNK_SIZE, found, emitted, errors } },
    });
    expect(served.payloads('job:checkpoint')).toEqual([cursor(925, 3, 3, 0), cursor(1911, 5, 4, 0), cursor(2897, 7, 5, 1), cursor(4140, 8, 6, 1)]);

    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing' }),
      // How far through the text the next piece starts: the cursor over the text's
      // length, both in code points. Over 4,250 the last two would be 43 and 50.
      report(job, 60, { code: 'creating-annotations', count: 3 }),
      report(job, 37, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 4 }),
      report(job, 44, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 5 }),
      report(job, 51, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 6 }),
      report(job, 100, { code: 'complete-created', count: 6, motivation: 'highlighting' }),
    ]);

    // Eight proposed, the repeat among them; six recorded; one that is nowhere in the text.
    expect(completion).toEqual({ ...identity(job), result: { found: 8, persisted: 6, errors: 1 }, durability: 'acknowledged' });
  });

  it('anchors a comment after such a character, and on one, at a count of code points', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, 'code-points-commenting', { motivation: 'commenting' }, {}, ENGINE);
    const resourceId = String(job.params.resourceId);
    w.ollama.script({
      response: JSON.stringify([
        { exact: 'Charles Babbage', comment: 'Designed the Analytical Engine.' },
        // One code point long.
        { exact: BOLD_B, prefix: 'numbers ', comment: 'The Bernoulli numbers.' },
        { exact: 'London', prefix: 'engine in ', comment: 'Where Babbage worked.' },
        // Nowhere in the text.
        { exact: `a difference engine ${TOOLS} of brass`, comment: 'Nowhere in the text.' },
      ]),
    });
    const served = await w.start();
    const completion = await settled(served, job);

    expect(codePoints(ENGINE).length).toBe(317);
    expect(ENGINE.length).toBe(320);

    // The prompt is 402 tokens, its 1,607 code points over four rounded up, and
    // the window is sized from that. Its 1,610 UTF-16 code units would be one
    // token more, and `num_ctx` 5794.
    expectGenerations(w.ollama.generations, [generation(agent.model, 'code-points-commenting', { num_predict: 5246, num_ctx: 5793, temperature: 0 }, FORMATS.commenting)]);
    expect(w.ollama.shows).toEqual([{ model: agent.model }]);

    const comment = (value: string) => [{ type: 'TextualBody', value, purpose: 'commenting', format: 'text/plain', language: 'en' }];
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        // Two characters outside the plane stand before it: a string's own position for it is 129.
        textAnnotation(
          w.generator(),
          resourceId,
          'commenting',
          '4J8akSbrbEyFdTzVXKTDl',
          {
            start: 127,
            end: 142,
            exact: 'Charles Babbage',
            prefix: `for computing the Bernoulli numbers ${BOLD_B} on the Analytical Engine.\n\n`,
            suffix: ` ${TOOLS} designed the engine in London, but it was never built. Lovelace`,
          },
          comment('Designed the Analytical Engine.'),
        ),
        // The span is the character itself: one code point, from 98 to 99.
        textAnnotation(
          w.generator(),
          resourceId,
          'commenting',
          '3O5sj9Qhk99Y9-ZgOt9kI',
          {
            start: 98,
            end: 99,
            exact: BOLD_B,
            prefix: 'first program in 1843 — a method for computing the Bernoulli numbers ',
            suffix: ` on the Analytical Engine.\n\nCharles Babbage ${TOOLS} designed the engine`,
          },
          comment('The Bernoulli numbers.'),
        ),
        textAnnotation(
          w.generator(),
          resourceId,
          'commenting',
          'lGrJCeVCNoP5O3pJU2XQ8',
          {
            start: 168,
            end: 174,
            exact: 'London',
            prefix: `the Analytical Engine.\n\nCharles Babbage ${TOOLS} designed the engine in `,
            suffix: ', but it was never built. Lovelace argued that the engine could manipulate',
          },
          comment('Where Babbage worked.'),
        ),
      ],
    ]);

    // The unit's cursor is the text's length in code points.
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { commenting: { next: 317, size: 2623, found: 4, emitted: 3, errors: 1 } } },
    ]);
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 3 }),
      report(job, 100, { code: 'complete-created', count: 3, motivation: 'commenting' }),
    ]);
    expect(completion).toEqual({ ...identity(job), result: { found: 4, persisted: 3, errors: 1 }, durability: 'acknowledged' });
  });
});
