// Ambient vocabulary for the agent skills' code fences (docs/builder/skills).
//
// A skill teaches a script in pieces: the first fence signs in, and the ones
// after it use what that fence made. Each fence is checked as a module of its
// own, so the names that carry from one fence to the next are declared here,
// typed against the real surface. Everything else a fence uses it imports or
// declares itself, as the script it teaches would.
import type {
  SemiontSession as _SemiontSession,
  SemiontClient as _SemiontClient,
  ResourceId as _ResourceId,
} from '@semiont/sdk';

declare global {
  /** The session the skill's setup fence signed in. */
  const session: _SemiontSession;
  /** That session's client. */
  const semiont: _SemiontClient;
  /** The resource the skill is working on. */
  const rId: _ResourceId;
}

export {};
