// owner-only.mjs — read and check specs/src/sign-in-store/owner-only.json: the
// modes a writer of the sign-in store gives its directory and its files, and
// the access list it gives the directory.
//
// One place for the checks, shared by the generators that read the file
// (generate-sign-in-go.mjs for the Go SDK and the launcher,
// generate-sign-in-python.mjs for the Python SDK), so no generated artifact
// comes from a file another would refuse. The Rust SDK's build script and the
// Kotlin SDK's generator make the same checks.

import { readFileSync } from 'node:fs';

/** Where the owner's SID goes in the access list. */
const OWNER = '{owner}';

/**
 * The directory's mode and the file's (each as the file writes it, four octal
 * digits, and in the digits after its leading zero), the access list split
 * around where the owner's SID goes, and each one's docs, the access list's
 * naming that place `owner`, as a generated function's argument; or exit 1
 * saying what is wrong with the file.
 */
export function readOwnerOnly(tablePath) {
  const refuse = (message) => {
    console.error(`✗ ${tablePath}: ${message}`);
    process.exit(1);
  };

  const { directoryMode, fileMode, accessList } = JSON.parse(readFileSync(tablePath, 'utf8'));
  const stated = (value) => typeof value === 'string' && value !== '';
  const mode = (which, entry) => {
    if (!entry || !stated(entry.docs) || !stated(entry.value) || !/^0[0-7]{3}$/.test(entry.value)) {
      refuse(`states no ${which}, one with no docs, or one that is not four octal digits`);
    }
    return { written: entry.value, octal: entry.value.slice(1), docs: entry.docs };
  };
  const directory = mode('directory mode', directoryMode);
  const file = mode('file mode', fileMode);
  if (!accessList || !stated(accessList.docs) || !stated(accessList.value)) refuse('states no access list, or one with no docs');
  const parts = accessList.value.split(OWNER);
  if (parts.length !== 2) refuse(`the access list names ${OWNER} ${parts.length - 1} times, not once`);
  const [before, after] = parts;
  return {
    directoryMode: directory,
    fileMode: file,
    accessList: { before, after, docs: accessList.docs.replaceAll(`\`${OWNER}\``, '`owner`') },
  };
}

/**
 * An access list as a file is given it: each entry's inheritance flags (the
 * second field of an access control entry) emptied, since a file has nothing
 * beneath it to hand an entry down to.
 */
export function forAFile(list) {
  const flagless = (text) => text.replace(/\(([^;()]*);[^;()]*;/g, '($1;;');
  return { before: flagless(list.before), after: flagless(list.after), docs: list.docs };
}
