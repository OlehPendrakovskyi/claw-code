# Design: credential redaction

Covers roadmap item **SEC-4**: the rewrite of credential redaction (`src/core/accessInfo/redact.ts`) around stated invariants, tracked in [#63](https://github.com/OlehPendrakovskyi/vsclaw/issues/63). Unlike the other designs here, this one describes a shipped feature that is being reworked. Status: in progress. The rules below are added section by section as each part of the rework lands; what is still open is listed under [Open questions](#open-questions). Back to the [roadmap](../roadmap.md).

## Problem

`redactText` masks credentials in text that leaves the process: logs, error messages, the Overview and reports. The text is untrusted, and so is its form: terminal codes, JSON escapes at any depth, pretty-printed structures, and URLs that do not parse. The masking grew one case at a time and has had findings in the same sections over several review rounds. Under R8 it is now rewritten as the invariants below, each with the mechanism that holds it.

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

## S. Span-based masking (planned, [#82](https://github.com/OlehPendrakovskyi/vsclaw/issues/82))

Status: in progress: S-a (`reading.ts`, `readingForRedaction`), S-b (`redactTextReading`, passes recording what they hide), S-c (`witness.ts`, `labelWitnesses`) and S-d (`redactTextReading` over every reading, `maskHiddenIn`) are built; S-e is not. It replaces choosing one reading of ambiguous text with masking everything any of a set of readings hides. It aims to close cases 8, 9 and 10 of #63 (open question 3) and J3's open question 2, and it claims to close them only once the acceptance test in S9 holds. It holds for S-d where what masks a value needs the bytes of one segment, with at most four of them: of 4,000 sampled inputs, 1,031 are such and have a subset of final bytes that hides the value, and the output hides it in every one; no input the subsets leave unmasked is masked. Cases 8, 9 and 10 are closed as far as that sample reaches. Beyond that scope, open question 4 tracks the leaks left. Case 5 (open question 1) is a policy choice that readings do not settle, and it stays as it is.

### Invariants

**S1. Edits are recorded against the input, with what they hide.** Every pass returns edits. An edit is an input span, the text that replaces it, and the input ranges it hides. What an edit hides does not follow from its text:
- `token: PRIVATE` becomes `token=***`, and hides the range of `PRIVATE`;
- a re-serialised URL hides the ranges of its userinfo and its sensitive query values, found in the raw text;
- a formatting-only edit hides nothing.

A pass may decide from parsed or normalised text, but its spans and hidden ranges are in input coordinates.

**S2. A reading is a normalisation of the input with a map back to it.** Each character of a reading maps to the input range it came from: one character, the escape it decodes (`\u0070`), or nothing for one normalisation inserts (`://` after `https:/`). Readings differ only where R79 and R62 leave a choice: which stripped final bytes stay, and so which split escapes decode.

**S3. The readings: the base reading, then each segment's choices, aligned.**
- The base reading is R79's first rule, which is today's output.
- A segment is a maximal stretch of name characters, marked final bytes, backslash runs and `%` (`witness.ts`). Its choices are which of its marked bytes to keep: every subset when it has at most four (`SUBSET_MARKS`), so a separator an escape spells (`\u002·2` is a quote) or a Basic payload's valid length is read as well as a label; otherwise none, all, and each label's witness.
- Reading *j* keeps each segment's choice *j*, or its base bytes when the segment has fewer choices. Every choice of every segment is read, but a choice of one segment is read alongside some choice of each other one, not every combination (open question 4).
- For each label in the vocabulary (keys, headers, `bearer`, `basic`), the witness reading keeps, in every run, only the final bytes of the first reading of that run that forms the label, and drops the rest. Witnesses are found by a label automaton that also decodes escapes whose digits are final bytes (case 9), in the pipeline's order: `\u00XX` as `decodeNameEscapes` does, then, for a query name, `%XX` as `URLSearchParams` does, from what that gave (`\u0025` is a `%`); a segment is read as text, which leaves `%XX`, and as a query name, each with its own witness, so a label only one of them forms does not stand in for the other's.
- Each witness reading is rendered on its own: it does not add to the base reading, so a byte that blocks the label there (`passx.basic`) is dropped.
- The set has as many readings as the segment with the most choices: at most 16, or 3 + twice the vocabulary's size for a longer segment, whatever the input. Text with no marked final byte has only the base reading.

**S4. The output is the base reading's edits plus what other readings hide.**
- The base reading applies all of its edits, so with no marked final byte the output is today's.
- Every other reading contributes the input ranges its edits hide (S1), whatever their text.
- Such a character outside every base edit is masked; adjacent ones form one `***`.
- One inside a base edit that the edit hides already is hidden.
- One inside a base edit that the edit does not hide turns that whole edit into `***`. This fails closed: a re-serialised URL or a reformatted pair in which another reading hides more is masked whole.

So the output hides at least what `main` hides today.

**S5. Passes report, they do not rewrite, and each sees today's intermediate text.** Each pass runs, in today's order and with today's regexes, on a view of the reading in which each edit made so far is applied, with a map from the view back to the reading. It returns its edits in view coordinates, which the maps carry back to the input.

The view after each pass is exactly the string today's pipeline holds at that point:
- a hidden value stands as the internal `MASK` sentinel, which later passes test for (`MASKED_VALUE` in `maskSensitivePairs`);
- a userinfo mask stands as today's literal `***@`;
- `redactUrl`'s masked query values are turned back into `MASK` (`MASKED_QUERY_VALUE`), as `maskNormalized` does now.

Only the final rendering turns `MASK` into `***`, as `unmask` does. S-b holds this by construction: each pass's string form returns its reading form's text, so there is one implementation of each, and the existing tests and a golden corpus of outputs from before S-b check the final text.

**S6. URLs keep today's spelling.** `redactUrl`'s re-serialised URL is one edit over the URL's span. It hides the input ranges of the userinfo and the sensitive query values that it masks, located in the raw text. A URL in which another reading hides a character outside those ranges is masked whole (S4). *As built:* `redactUrl` locates its masks in the raw text, the userinfo and each sensitive name's first value, and every later entry whole since it drops those. The unparsed fallback replays its own userinfo and query patterns on the raw text. When the raw text cannot account for every name the parser masked (a name that decodes only after the parser drops a tab in it), the URL's whole span is hidden instead. The re-serialised URL is aligned with the raw one: its unchanged prefix and suffix keep their own ranges, so a later pass's mask over them does too.

**S7. Linear.** Each reading costs one run of the pipeline, the number of readings is bounded (S3), and each map is linear in its text, so the whole costs a constant times the input (R64). Text with no marked final byte runs the pipeline once, as today.

**S8. Joins compare hidden ranges.** `joinBoundary`'s J3 test becomes exact: the join hides more when the input ranges the joined text's edits hide (S1) hold a character that those of the parts hidden apart do not. This replaces the subsequence check.

**S9. Acceptance is judged on every subset, not on the chosen readings.** The test for S-d generates short inputs (label words split by codes, junk codes, separators and contexts, as in #81's oracle). It asserts that if redacting **any** subset of the final bytes as plain text hides the value, the output hides it too. Its subsets range freely, so it detects a reading S3 does not hold. S-d ships only when it finds no leak that `main` does not share. A shape it still finds stays an open question; it is not claimed fixed.

### Mechanism

- **Data.**
  - `Reading { text: string; from: Int32Array; to: Int32Array }` holds the input range of each character.
  - `Edit { from: number; to: number; text: string; hides: Array<[number, number]> }` is in input coordinates. When edits compose, as a later pass rewriting text an earlier one produced, their `hides` are carried through, merged and mapped.
  - A `Uint8Array` over the input holds the characters other readings hide.
- **Normalisation.** `stripTerminalCodes`, `decodeNameEscapes` and `normalizeSpecialSchemes` each return their output with its map, and the maps compose. `keepLabelBytes` resolves the marks once per reading. Stripping repeats until it changes nothing, since removing a control byte or keeping a final byte can assemble another code (`\u00` NUL `1b[0m`, `\u001·b[0m`); each reading is stripped again after its bytes are resolved (`settledIn`). Both are bounded by `STRIP_PASSES` (4): text that still changes is withheld as `REDACT_NESTED_WITHHELD` (R64).
- **Passes.** Each of the following returns edits instead of text:
  - `maskBrokenUserinfo`, `maskUserinfo` and `NETWORK_PATH_USERINFO`;
  - `maskAmbiguousNetworkUserinfo`, `maskSensitivePairs` and `maskQueryPairs`;
  - `redactUrl`;
  - `maskPlainSecrets`, with the Bearer, Basic and header masks inside it.
  
  A helper applies a pass's edits to its view and maps them back.
- **Rendering.** `maskHiddenIn` (`reading.ts`) applies S4 to the base reading's output. A stretch that stands for one input range (a copied character, a decoded escape, one edit's text) is masked whole when that range holds a character another reading hides and the base does not. A new mask takes in a `***` of the base's own next to it. `redactTextReading` runs each distinct reading once (S7).
- **Callers.** Text reaches `redactText` with its terminal codes: `redactEndpointText` no longer strips them first, which settled the final bytes on the base reading alone (R81). The ACP error details in `ChatService` still do, since they are serialised before redaction and serialising changes what a code is (#88 review); their readings are a known gap of R81. `redactTextAndSecret` keeps running `maskSecretFragments` on the rendered text, as today.

### Delivery

| PR | Scope | Output change |
|---|---|---|
| S-a | `Reading` and maps for the three normalisation steps; a golden corpus, generated from the pre-refactor implementation, that the base reading's text must equal | none |
| S-b | Every pass reports edits with what they hide, `redactUrl` included (S1, S5, S6); the base reading rendered with its edits; a golden corpus of today's outputs | none: every existing test and the corpus pass unchanged, and each view equals today's intermediate string |
| S-c | The witness automaton, escape-aware (S3); unit-tested on runs alone | none |
| S-d | The readings and their union (S3, S4), with S9's acceptance test | cases 8, 9 and 10 masked, as far as S9 confirms |
| S-e | `joinBoundary` on spans (S8) | closes open question 2 |

Effort: L–XL in total. S-a, S-b and S-c change no output.

### Open questions for the design

1. **Cost.** Text with marked final bytes runs the pipeline once per reading (S3). Linear, but each such text costs up to about 16 times as much. Should a text above a size limit with many marked bytes be withheld instead (R64)? *Measured with S-d:* readings that keep the same bytes run once, so the worst case found is a text the pipeline is slowest on after a run whose codes spell every label. At 256 KiB it takes 1.4–2.6 s, against 0.12–0.15 s for the same text without the codes, which runs once as on `main` (no coverage). The cost test in `redactReadings.test.ts` bounds it at 32 KiB. *Decided 2026-10-20 by the owner:* text over 1 MiB is withheld whole rather than redacted (`REDACT_MAX_CHARS`, #89, R64), which bounds the worst case at about four times the 256 KiB figure.
2. **Witnesses across runs.** A witness reading picks each run's bytes on its own. A label whose masking depends on two runs together (a key in one run, a continuation in the next) is not chosen jointly. S9's test is what would show whether this matters.
3. **R0.** Cases 8, 9 and 10 are leaks on contrived terminal-code input. Should #82 block R0 (SEC-4), or ship after it with these cases documented? *Decided 2026-10-19 by the owner:* #82 blocks R0.
4. **Readings S3 does not hold.** Two shapes still leak, both found by widening S9's sample after #88's review: a segment of more than four marked bytes whose label and separator need choices no witness makes together (`pass·wo·rd\u002·1·2=PRIVATE`, where the witness drops the quote's digit), and a value that needs choices in two segments together (`b·as·ic PRIVATE·x·y`, where `basic` and a valid payload length come from different segments; or `x·p\u001·b[0mas·s·mword=PRIVATE`, where the `[` of a code the kept `b` assembles ends a segment inside the label). On that widened sample, 2,131 inputs have a subset that hides the value; the output shows it in 576, and `main` in 1,542. Reading every combination is exponential in the bytes, and a rule per shape is what R8 stopped in #81. Closing them needs a reading set chosen by what the passes need after a label (its separator, a payload), not by the label alone.

## Open questions

1. **Case 5: prose after a host and port** ([#63](https://github.com/OlehPendrakovskyi/vsclaw/issues/63)). `https://host:8080 see bob@example.org` is masked as `https://***@example.org/`, and its join form shows `https://*** (***)`. #80 tried six review rounds of narrower rules (the next word only after a host and port, then a host with no port, trimmed punctuation, a join rule) and dropped them under R8. Each one let a password through, because these inputs are syntactically the same:
   - `https://host:8080 see bob@example.org`, which is prose;
   - `https://alice:123 PRIVATE_PREFIX PRIVATE_SUFFIX@host`, a password holding a space;
   - `https://alice:123 PRIVATE_PREFIX` + `reason PRIVATE_SUFFIX@host`, a password split between a label and its details (R76).
   
   Any rule that keeps the first visible exposes the other two. A fix needs information the text does not carry, such as a caller that knows a part is prose. Until then, over-masking is the safe failure. The regression tests pin every shape that leaked in #80.
2. **J3: a join that both hides and reveals text.** The subsequence check can be fooled when the revealed text repeats what was hidden. The exact alternative tracks hidden input positions through every pass, which needs `redactUrl`'s re-serialisation reworked.
3. **Which final bytes of a stripped terminal code to keep (cases 8 and 10).** *Closed by S-d, as far as S9's test samples:* `redactText` masks what any reading of the bytes hides, so no reading has to be chosen. The history below is kept for the shapes it pins. When a terminal code is stripped, its final byte may be a letter a credential label needs (`ESC[token=…`). R79 keeps a byte that completes a label on its own, or all of a run's bytes if together they make one. That misses:
   - a label that needs some of the bytes but not the others: `p ESC(a ESC(s ESC(s ESC(x=PRIVATE` becomes `p=PRIVATE` (case 8);
   - a label judged without the separator after it: `toke ESC(n-bearer=PRIVATE` becomes `toke-bearer=PRIVATE`, because `bearer` counts though the Bearer pass needs whitespace (case 10).
   
   #81 tried, over six review rounds, to pick the one reading of the bytes that holds a label. It was dropped under R8. Every rule that chose a reading changed text another pass depends on:
   - a header's whole name (`cookie`);
   - a Basic payload, whose base64 length changes with any byte;
   - a label of the other kind (`key.bearer`).
   
   Or it chose by a measure that does not hold: a bounded window around the run, "fewer characters visible", or a key separator after the run, which may be Basic padding. Its separator check also went quadratic. The regression tests from #81 pin every shape that leaked, and `main` masks each of them.
   
   The direction is span-based masking: compute which input spans any reading of the bytes would hide, and mask their union, instead of choosing a reading. It covers cases 5, 8, 9 and 10 alike and is designed in [section S](#s-span-based-masking-planned-82) ([#82](https://github.com/OlehPendrakovskyi/vsclaw/issues/82)).
