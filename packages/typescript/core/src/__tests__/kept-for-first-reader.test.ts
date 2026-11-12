import { describe, it, expect } from 'vitest';
import { ERRORS_KEPT_FOR_FIRST_READER_COUNT } from '../generated/client-timing';
import { KeptForFirstReader } from '../kept-for-first-reader';

function heardBy<T>(stream: KeptForFirstReader<T>): { heard: T[]; ended: () => boolean } {
  const heard: T[] = [];
  let ended = false;
  stream.said$.subscribe({ next: (value) => heard.push(value), complete: () => { ended = true; } });
  return { heard, ended: () => ended };
}

describe('KeptForFirstReader', () => {
  it('gives its first reader the latest ERRORS_KEPT_FOR_FIRST_READER_COUNT said before it came, in order, the oldest dropped', () => {
    const stream = new KeptForFirstReader<number>();
    const beyond = 5;
    const said = Array.from({ length: ERRORS_KEPT_FOR_FIRST_READER_COUNT + beyond }, (_, n) => n);
    for (const value of said) stream.say(value);

    expect(heardBy(stream).heard).toEqual(said.slice(beyond));
  });

  it('gives a later reader only what is said from when it reads, and every reader what is said after', () => {
    const stream = new KeptForFirstReader<string>();
    stream.say('before anyone read');
    const first = heardBy(stream);
    stream.say('before the second read');
    const second = heardBy(stream);
    stream.say('after both read');

    expect(first.heard).toEqual(['before anyone read', 'before the second read', 'after both read']);
    expect(second.heard).toEqual(['after both read']);
  });

  it('drops what it kept when it ends: a reader who comes after is given nothing, and is told the stream has ended', () => {
    const stream = new KeptForFirstReader<string>();
    stream.say('said before anyone read');
    stream.end();
    stream.say('said after the end');

    const late = heardBy(stream);
    expect(late.heard).toEqual([]);
    expect(late.ended()).toBe(true);
  });
});
