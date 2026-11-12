/**
 * A renewal several refusals wait on, which its owner's close ends: an
 * agent's on `stop()`, a session's on `dispose()`. Each refusal waiting on a
 * renewal the close ended is given no token at once, as when the issuer gives
 * none. What the renewal brings after is nobody's, and so is its failure.
 */
export interface SharedRenewal<T> {
  /** What each refusal waiting on the renewal is given. */
  readonly answer: Promise<T | null>;
  /** End the renewal: each refusal waiting on it is given no token. */
  end(): void;
}

export function sharedRenewal<T>(renewal: Promise<T>): SharedRenewal<T> {
  let end!: () => void;
  const answer = new Promise<T | null>((resolve, reject) => {
    end = () => resolve(null);
    void renewal.then(resolve, reject);
  });
  return { answer, end };
}
