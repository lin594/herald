export const SERVERCHAN3_SENDKEY_ERROR =
  "SERVERCHAN3_SENDKEY must be a ServerChan³ SendKey in sctp<uid>t<key> format";

/** Validate only the documented key shape; the service verifies credentials. */
export function serverChan3Uid(sendKey: string): string {
  const match = /^sctp(\d+)t\S+$/.exec(sendKey);
  if (!match || sendKey.trim() !== sendKey) {
    throw new Error(SERVERCHAN3_SENDKEY_ERROR);
  }
  return match[1];
}
