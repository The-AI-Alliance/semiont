/**
 * Base64url (RFC 4648 section 5), unpadded: what the id of an annotation is
 * cut from. Private to this package.
 */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
