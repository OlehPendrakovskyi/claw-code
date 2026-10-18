# Design: credential redaction

Covers roadmap item **SEC-4**: the rewrite of credential redaction (`src/core/accessInfo/redact.ts`) around stated invariants, tracked in [#63](https://github.com/OlehPendrakovskyi/vsclaw/issues/63). Unlike the other designs here, this one describes a shipped feature that is being reworked. Status: in progress. The rules below are added section by section as each part of the rework lands. Back to the [roadmap](../roadmap.md).

## Problem

`redactText` masks credentials in text that leaves the process: logs, error messages, the Overview and reports. The text is untrusted, and so is its form: terminal codes, JSON escapes at any depth, pretty-printed structures, and URLs that do not parse. The masking grew one case at a time and has had findings in the same sections over several review rounds. Under R8 it is now rewritten as the invariants below, each with the mechanism that holds it.

## U. Malformed URL userinfo

**U2. After a host and port, a password goes on only within the next word.** U2 applies when the authority before the whitespace parses, under the URL's own scheme, as a host and an explicit port with no userinfo (`https://host:8080`, `https://[::1]:8080`, `ssh://alice%20smith:123`). A password then continues past that whitespace, which may be any whitespace but a line end, only within the next whitespace-free word, and that word must hold the `@`.

- Masked: `https://alice:123 PRIVATE@host` and `https://alice:123 PRIVATE/part@host`.
- Kept: `https://host:8080 see bob@example.org`. An `@` in a later word is prose.
- An authority that parses with no port (`https://example.com: docs/a@b`, `https://[::1] see a@b`) is followed by no password.
- An authority that does not parse gets U1, including a digit run that is no valid port (`alice:99999`).
- Nothing after the authority is trimmed before it is parsed. Punctuation there may open a password (`alice:!`), so `https://host:8080: …` does not parse and is masked by U1.
- Accepted over-redaction: `https://host:8080 bob@example.org` has the shape of a password and is masked.

**U3. A password run that goes to "the last `@` on its line" ends at LF, CR, U+2028 or U+2029.** These runs (a password holding whitespace, and the search for a path after a port-like prefix) use this one set (`LINE_END`), so an email on a later line of prose is not read as part of such a password.

- **U3a. Exception: characters a URL parser drops.** A parser removes tabs, LF and CR anywhere in a URL, so a userinfo that holds no other whitespace runs across them as the parser reads it. Examples: `https://alice:123\nmore\nPRIVATE@host` and `//example.com\nbob@example.org`, which a parser reads as one URL and which are masked as one.
- **U3b. No exception for U+2028 and U+2029.** A parser treats them as whitespace, so they always end a run.

**U4. The network-path form follows the same rules as the scheme form.** `//alice:…` (RFC 3986 §4.2) and `https://alice:…` are delimited alike. Every userinfo test covers both spellings.

### Mechanism

- `maskUserinfo` and `scanLine` (the `scheme://` form) and `maskAmbiguousNetworkUserinfo` (the `//` form) end a line with `LINE_END`.
- `NETWORK_PATH_USERINFO` excludes the same four characters from its spaced-password alternative.
- U1 and U2 are decided in one place, `authorityKind`. It reads an authority that holds no `@`, with prose punctuation dropped, as a host and an explicit port, a host alone, or unparsable. It reads the URL's parse under its own scheme, since a non-special scheme (`ssh:`) accepts hosts that `http:` rejects. A network-path reference is parsed as `http:`.
  - In `maskUserinfo`, the spaced-password block takes U2 (the next word) for a host and port, nothing for a host alone, and U1's same-line run for an unparsable authority.
  - `maskAmbiguousNetworkUserinfo` does the same for the `//` form. It is the only pass that decides a network-path password holding whitespace: `NETWORK_PATH_USERINFO` matches no whitespace at all.
- U3a is held by `maskBrokenUserinfo`, which reads an authority across tabs, LF and CR up to its first `/`, `?`, `#` or other whitespace. It is also held by the break-crossing in `maskUserinfo` (`PARSER_IGNORED_CHAR`), which applies only to a `user:` run.

## J. Joins

`joinBoundary` decides how to show two parts that were redacted apart and are displayed together (a label and its endpoint, an error message and its details), when a credential may span them.

**J3. A join hides more only when it hides text the apart rendering shows.** Two renderings are compared: the joined one, `maskNormalized(l + r)`, and the apart one, `maskNormalized(l) + maskNormalized(r)` (R74). The join hides more when both of these hold:

- the joined rendering holds a mask;
- with every `***` removed from both renderings, the apart text is not a subsequence of the joined text.

A mask that both renderings keep shows no join-formed credential. That includes a side's own credential (`see https://alice:pw@host/ then` + `pass=PRIVATE`) and a literal `***` in the input (`*** nearby` + `pass=PRIVATE`). A credential that runs on from one side into the other hides text of that side, so it still counts.

### Mechanism

- `hidesMore` holds J3 for `joinFormedCredential`, `consumesTail` (the label probe) and the delimited userinfo probe of `joinBoundary`.
- `isSubsequence` reads each string once, so the check is linear (R64).

## Open questions

1. **The join form of case 5.** `joinBoundary('https://host:8080', 'contact bob@example.org')` still masks the right side, so `formatNamedEntry` shows `https://*** (***)`. A rule that read the join as U2 does (J2) was tried in #80 and dropped after four review rounds, under R8:
   - A password's leading digits look like a port.
   - The `@` that completes a split password may sit past other fields or lines (R76).
   - A port-like ending may belong to a query (`?token=PREFIX:8080`).
   
   Over-masking the join is the safe failure.
2. **Prose punctuation after a port.** `https://host:8080: contact bob@example.org` is masked, and so is the `ChatService` rendering `message: details`, because `:`, `)` or `,` after the port may open a password.
3. **U2's over-redaction.** `https://host:8080 bob@example.org` is masked because it has the same shape as `https://alice:123 PRIVATE@host`. Telling them apart would need a guess about the text rather than its syntax.
4. **U2 and parser-dropped tabs.** `https://host:8080\tthen bob@example.org` is still masked. A parser drops the tab and reads `host:8080then`, which does not parse, so U3a's run applies rather than U2.
5. **J3: a join that both hides and reveals text.** The subsequence check can be fooled when the revealed text repeats what was hidden. The exact alternative tracks hidden input positions through every pass, which needs `redactUrl`'s re-serialisation reworked.
