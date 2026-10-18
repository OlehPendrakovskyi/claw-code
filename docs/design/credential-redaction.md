# Design: credential redaction

Covers roadmap item **SEC-4**: the rewrite of credential redaction (`src/core/accessInfo/redact.ts`) around stated invariants, tracked in [#63](https://github.com/OlehPendrakovskyi/vsclaw/issues/63). Unlike the other designs here, this one describes a shipped feature that is being reworked. Status: in progress. The rules below are added section by section as each part of the rework lands. Back to the [roadmap](../roadmap.md).

## Problem

`redactText` masks credentials in text that leaves the process: logs, error messages, the Overview and reports. The text is untrusted, and so is its form: terminal codes, JSON escapes at any depth, pretty-printed structures, and URLs that do not parse. The masking grew one case at a time and has had findings in the same sections over several review rounds. Under R8 it is now rewritten as the invariants below, each with the mechanism that holds it.

## T. Terminal-code stripping

A terminal code is stripped before any masking pass runs. Its final byte may be a letter that a credential label needs (`ESC[token=…`, whose `t` is the final byte), so a final byte that is a name character is marked, and each run of name characters holding marked bytes is resolved once every other code and control byte is gone (R79).

**T1. One label vocabulary.** The strip-time label check knows exactly the labels the masking passes read: `LABELS` in `redact.ts`. Each one says where it may sit in a run: anywhere (`SENSITIVE_KEY`, `CREDENTIAL_HEADER_KEY`), apart from other letters (`pass`), or as a whole word ending the run (`bearer`, `basic`, as `LABEL_WORD`). Every spelling those regexes accept beyond these (`api_key`, `access-key`, `set-cookie`) contains one of them.

**T2. A label is judged with the separator after it.** A key or header label counts only before a key separator (`:` or `=`, after optional closing quotes and whitespace) or before any text but whitespace, which a query name may run on through (`?to ESC(k en+x=`). `bearer` and `basic` count only before whitespace, as the Bearer and Basic passes need. At the end of the text either may follow.

**T3. A run keeps the final bytes of a reading that holds a label, and only those.**
- If the run with no marked byte kept holds a label that T2 allows, every marked byte goes (`ESC[0mtoken=` loses the `m`).
- Otherwise, if any subset of the marked bytes kept forms such a label, the bytes of one such reading stay and every other marked byte goes: `p ESC(a ESC(s ESC(s ESC(x=` becomes `pass=`, and `toke ESC(n-bearer=` becomes `token-bearer=`.
- With no such reading, every marked byte goes, so a run that forms no credential label loses its codes whole.

### Mechanism

- `keepRunLabelBytes` reads T2 from the text right after the run (`SPACE_AT`, `KEY_SEPARATOR_AT`), tests the run without its marked bytes with the masking passes' own regexes, and otherwise asks `labelReading`.
- `labelReading` matches each allowed label with a small automaton. Its state is the set of prefix lengths matched so far, as bits: a fixed character must extend a prefix, and a marked one may extend it or be skipped. Where a bounded label may start and end is read from the nearest fixed character on each side, since every marked byte outside the match goes. The states before each character are kept, so `readingOf` finds the match's bytes going back from its end.
- Each label reads the run once forward and its match once back, with constant work per character, so stripping stays linear (R64).
- A test checks T3 directly: for a fixed-seed sample of label words split by codes, if any reading of the final bytes hides the value, the text with its codes must too.

## U. Malformed URL userinfo

**U3. A password run that goes to "the last `@` on its line" ends at LF, CR, U+2028 or U+2029.** These runs (a password holding whitespace, and the search for a path after a port-like prefix) use this one set (`LINE_END`), so an email on a later line of prose is not read as part of such a password.

- **U3a. Exception: characters a URL parser drops.** A parser removes tabs, LF and CR anywhere in a URL, so a userinfo that holds no other whitespace runs across them as the parser reads it. Examples: `https://alice:123\nmore\nPRIVATE@host` and `//example.com\nbob@example.org`, which a parser reads as one URL and which are masked as one.
- **U3b. No exception for U+2028 and U+2029.** A parser treats them as whitespace, so they always end a run.

**U4. The network-path form follows the same rules as the scheme form.** `//alice:…` (RFC 3986 §4.2) and `https://alice:…` are delimited alike. Every userinfo test covers both spellings.

### Mechanism

- `maskUserinfo` and `scanLine` (the `scheme://` form) and `maskAmbiguousNetworkUserinfo` (the `//` form) end a line with `LINE_END`.
- `NETWORK_PATH_USERINFO` excludes the same four characters from its spaced-password alternative.
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

1. **Case 5: prose after a host and port** ([#63](https://github.com/OlehPendrakovskyi/vsclaw/issues/63)). `https://host:8080 see bob@example.org` is masked as `https://***@example.org/`, and its join form shows `https://*** (***)`. #80 tried six review rounds of narrower rules (the next word only after a host and port, then a host with no port, trimmed punctuation, a join rule) and dropped them under R8. Each one let a password through, because these inputs are syntactically the same:
   - `https://host:8080 see bob@example.org`, which is prose;
   - `https://alice:123 PRIVATE_PREFIX PRIVATE_SUFFIX@host`, a password holding a space;
   - `https://alice:123 PRIVATE_PREFIX` + `reason PRIVATE_SUFFIX@host`, a password split between a label and its details (R76).
   
   Any rule that keeps the first visible exposes the other two. A fix needs information the text does not carry, such as a caller that knows a part is prose. Until then, over-masking is the safe failure. The regression tests pin every shape that leaked in #80.
2. **J3: a join that both hides and reveals text.** The subsequence check can be fooled when the revealed text repeats what was hidden. The exact alternative tracks hidden input positions through every pass, which needs `redactUrl`'s re-serialisation reworked.
