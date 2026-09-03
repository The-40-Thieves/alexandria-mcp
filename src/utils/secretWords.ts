// The shared word-based credential test src/log.ts's log redaction and
// src/utils/http.ts's URL redaction both use, split out to a dependency-
// free module so http.ts can reuse it without a cycle back through log.ts
// (log.ts itself imports requestContext from http.ts).
//
// Word-tokenized rather than one regex: `\bkey\b` does NOT work here
// because `_` is a word character, so there is no word boundary between
// "_" and "K" in "ROLE_KEY" - a real gap this fixes (SUPABASE_SERVICE_ROLE_KEY
// went unredacted under a previous substring-anchored regex, which only
// matched "key" when immediately preceded by "api"). Splitting on
// camelCase transitions and any run of non-alphanumeric characters, then
// comparing whole lowercase words against SENSITIVE_WORDS, catches a
// standalone "key"/"token"/... segment wherever it sits - ROLE_KEY,
// api_key, apiKey, Authorization - without a bare substring match also
// catching an unrelated field that merely contains one as a fragment
// (monkeyPatch, keyboardLayout).
const SENSITIVE_WORDS = new Set([
  'key',
  // A handful of source adapters (bhl.ts, newsdata.ts, ctext.ts) name their
  // query-string auth param literally `apikey`, with no separator or
  // camelCase transition to split on - fieldWords() would otherwise tokenize
  // that as one word, "apikey", which "key" alone does not catch.
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'bearer',
  'auth',
  'authorization',
  'authorised',
  'authorized',
]);

export function fieldWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

export function isSensitiveKey(name: string): boolean {
  return fieldWords(name).some((word) => SENSITIVE_WORDS.has(word));
}
