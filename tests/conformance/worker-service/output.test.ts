/**
 * What a Worker service writes (WORKER-SERVICE.md § Output): every line a log
 * line, on stdout, in the form its document's `logFormat` names; and nothing
 * on stderr.
 */
import { expect, it } from 'vitest';
import { eachWorkerService, type Served, type WorkerServiceWorld } from '../harness/worker-service-world';
import { markJob, settled } from './support';

const SCHEMA = {
  id: 'argument',
  name: 'Argument',
  description: 'What a text claims and what it offers in support',
  domain: 'rhetoric',
  tags: [{ name: 'Claim', description: 'What the text asserts', examples: ['What is being asserted?'] }],
};

/**
 * A job of each kind whose answer a service reads element by element, each
 * with a proposal that is in the text and one that is nowhere in it: what a
 * service has to say of an answer, it says while it runs these.
 */
async function ran(w: WorkerServiceWorld, logFormat: 'json' | 'simple'): Promise<Served> {
  const nowhere = 'a difference engine of polished brass that was never described';
  const jobs = [
    markJob(w, `output-${logFormat}-highlighting`, { motivation: 'highlighting' }),
    markJob(w, `output-${logFormat}-commenting`, { motivation: 'commenting' }),
    markJob(w, `output-${logFormat}-assessing`, { motivation: 'assessing' }),
    markJob(w, `output-${logFormat}-tagging`, { motivation: 'tagging', schemaId: SCHEMA.id, categories: ['Claim'], schema: SCHEMA }),
    markJob(w, `output-${logFormat}-linking`, { motivation: 'linking', entityTypes: ['Person'] }),
  ];
  w.ollama.script(
    { response: JSON.stringify([{ exact: 'the first program' }, { exact: nowhere }]) },
    { response: JSON.stringify([{ exact: 'Ada Lovelace', comment: 'She wrote the notes.' }, { exact: nowhere, comment: 'Nowhere.' }]) },
    { response: JSON.stringify([{ exact: 'London was wrong.', assessment: 'No source is given.' }, { exact: nowhere, assessment: 'Nowhere.' }]) },
    { response: JSON.stringify([{ exact: 'London was wrong.' }, { exact: nowhere }]) },
    { response: JSON.stringify([{ exact: 'Ada Lovelace', entityType: 'Person' }, { exact: nowhere, entityType: 'Person' }]) },
    { response: '2' },
  );
  const served = await w.start({ settings: { logLevel: 'debug', logFormat } });
  for (const job of jobs) await settled(served, job);
  expect(await served.process.stop()).toBe(0);
  return served;
}

eachWorkerService("the worker's output", (world) => {
  it('writes every line as a JSON log line on stdout, and nothing on stderr, when its document says json', async () => {
    const served = await ran(world(), 'json');
    expect(served.process.stdout.length).toBeGreaterThan(0);
    for (const line of served.process.stdout) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        entry = undefined;
      }
      expect(typeof entry === 'object' && entry !== null && !Array.isArray(entry), `not a JSON object: ${line}`).toBe(true);
      const { level, message } = entry as { level?: unknown; message?: unknown };
      expect(typeof level === 'string' && typeof message === 'string', `no level or message: ${line}`).toBe(true);
    }
    expect(served.process.stderr).toEqual([]);
  });

  it('writes every line as a plain log line on stdout, and nothing on stderr, when its document says simple', async () => {
    const served = await ran(world(), 'simple');
    expect(served.process.stdout.length).toBeGreaterThan(0);
    // A log line begins with when and how grave. A line that is the rest of a message spread over several begins with neither.
    const unlike = served.process.stdout.filter((line) => !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[A-Z]+\] /.test(line));
    expect(unlike).toEqual([]);
    expect(served.process.stderr).toEqual([]);
  });
});
