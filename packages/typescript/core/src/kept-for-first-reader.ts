import { Observable, Subject } from 'rxjs';
import { ERRORS_KEPT_FOR_FIRST_READER_COUNT } from './generated/client-timing';

/**
 * A stream whose first reader is given the latest
 * `ERRORS_KEPT_FOR_FIRST_READER_COUNT` said before it came, in the order they
 * were said, the oldest beyond them dropped; every later reader hears what is
 * said from when it reads. When the stream ends, what is still kept is
 * dropped: a reader that comes after the end is given nothing.
 */
export class KeptForFirstReader<T> {
  readonly #said = new Subject<T>();
  /** What was said while nobody has read, for the first who does; null once one has, or the stream has ended. */
  #kept: T[] | null = [];

  readonly said$: Observable<T> = new Observable<T>((reader) => {
    const kept = this.#kept;
    this.#kept = null;
    if (kept !== null) for (const value of kept) reader.next(value);
    return this.#said.subscribe(reader);
  });

  /** Say `value` to every reader, or, while none has come, keep it for the first. */
  say(value: T): void {
    if (this.#kept === null) {
      this.#said.next(value);
      return;
    }
    this.#kept.push(value);
    if (this.#kept.length > ERRORS_KEPT_FOR_FIRST_READER_COUNT) this.#kept.shift();
  }

  /** End the stream for every reader, dropping what was kept for a first who has not come. */
  end(): void {
    this.#kept = null;
    this.#said.complete();
  }
}
