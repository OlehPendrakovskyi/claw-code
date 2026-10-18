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

Status: design, not implemented. It replaces choosing one reading of ambiguous text with masking everything any of a fixed set of readings hides. That closes cases 8, 9 and 10 of #63 (open question 3) and J3's open question 2. Case 5 (open question 1) is a policy choice that readings do not settle, and it stays as it is.

### Invariants

**S1. A mask is a set of input characters.** Every masking decision marks characters of the original input as hidden. A pass may decide from parsed or normalised text, but what it hides is recorded in input coordinates.

**S2. A reading is a normalisation of the input with a map back to it.** Each character of a reading maps to the input range it came from: one character, the escape it decodes (`\u0070`), or nothing for one normalisation inserts (`://` after `https:/`). Readings differ only where R79 and R62 leave a choice: which stripped final bytes stay, and so which split escapes decode.

**S3. The readings are a fixed, small set.** There are four:
- the base reading, R79's first rule, which is today's output;
- every final byte dropped;
- every final byte kept;
- every run with the bytes of its first key-label reading added, found by the linear label automaton from #81's history (`labelBytes` in #81, commit 68db3b2).

The count does not grow with the input.

**S4. The output hides the union.** An input character that any reading hides is hidden in the output. The output is the base reading, with each maximal run of characters whose input range holds a hidden character replaced by one `***`. Since the base reading is one of the set, the output hides at least what `main` hides today.

**S5. Passes report, they do not rewrite.** Each masking pass runs, in today's order and with today's regexes, on a view of the reading in which every span hidden so far is folded to one `MASK` character. It returns the spans it hides in view coordinates, which the fold maps back to the reading and then to the input.

**S6. URLs keep their spelling.** `redactUrl` and `redactEndpoint` use `new URL()` only to decide which components are credentials, and locate them in the raw text. The output keeps the input's spelling: no added trailing `/`, `é` not `%C3%A9`, a default port kept, and each duplicate of a sensitive parameter masked rather than dropped.

**S7. Linear.** Each reading costs one run of the pipeline, and each fold and map is linear in its text, so the whole costs a constant times the input (R64).

**S8. Joins compare spans.** `joinBoundary`'s J3 test becomes exact: the join hides more when the joined text hides an input character that the parts hidden apart do not. This replaces the subsequence check.

### Mechanism

- **Data.** `Reading { text: string; from: Int32Array; to: Int32Array }` holds the input range of each character. A `Uint8Array` over the input holds hidden characters, and a union is a bitwise OR.
- **Normalisation.** `stripTerminalCodes`, `decodeNameEscapes` and `normalizeSpecialSchemes` each return their output with its map, and the maps compose. `keepLabelBytes` builds the four readings from the same marked text in one pass, so the marks are resolved once per reading.
- **Passes.** Each of `maskBrokenUserinfo`, `maskUserinfo`, `NETWORK_PATH_USERINFO`, `maskAmbiguousNetworkUserinfo`, `maskSensitivePairs`, `maskQueryPairs`, `redactUrl` and `maskPlainSecrets` (with the Bearer, Basic and header masks inside it) returns hidden spans instead of text. The fold helper turns view spans into reading spans.
- **Rendering.** `renderHidden(base, hidden)` writes the base reading with hidden runs as `***`. `redactTextAndSecret` keeps running `maskSecretFragments` on the rendered text, as today.

### Delivery

| PR | Scope | Output change |
|---|---|---|
| S-a | `Reading` and maps for the three normalisation steps; a property test that rendering with nothing hidden gives today's normalised text | none |
| S-b | Every pass but `redactUrl` reports spans. `redactUrl` stays a replacement inside the base reading only | none; every existing test passes unchanged |
| S-c | `redactUrl` and `redactEndpoint` report spans (S6) | URL spelling; the tests that assert a re-serialised form are updated |
| S-d | The four readings and their union (S3, S4) | cases 8, 9 and 10 masked; the #81 oracle becomes a property test over the set |
| S-e | `joinBoundary` on spans (S8) | closes open question 2 |

Effort: L–XL in total. S-a and S-b are refactors with unchanged output, so their tests are today's tests.

### Open questions for the design

1. **S6's spelling change.** It reaches `redactEndpointText`, which the Overview and the hardening report show. Keeping the input's spelling is arguably better fidelity, but it is visible.
2. **The reading set.** A fixed set covers every shape #81 found. Exhaustive readings, 2^n per run, would not be linear. Is a fixed set enough, or should a run with more than a few final bytes withhold its text instead?
3. **R0.** Cases 8, 9 and 10 are leaks on contrived terminal-code input. Should #82 block R0 (SEC-4), or ship after it with these cases documented?

## Open questions

1. **Case 5: prose after a host and port** ([#63](https://github.com/OlehPendrakovskyi/vsclaw/issues/63)). `https://host:8080 see bob@example.org` is masked as `https://***@example.org/`, and its join form shows `https://*** (***)`. #80 tried six review rounds of narrower rules (the next word only after a host and port, then a host with no port, trimmed punctuation, a join rule) and dropped them under R8. Each one let a password through, because these inputs are syntactically the same:
   - `https://host:8080 see bob@example.org`, which is prose;
   - `https://alice:123 PRIVATE_PREFIX PRIVATE_SUFFIX@host`, a password holding a space;
   - `https://alice:123 PRIVATE_PREFIX` + `reason PRIVATE_SUFFIX@host`, a password split between a label and its details (R76).
   
   Any rule that keeps the first visible exposes the other two. A fix needs information the text does not carry, such as a caller that knows a part is prose. Until then, over-masking is the safe failure. The regression tests pin every shape that leaked in #80.
2. **J3: a join that both hides and reveals text.** The subsequence check can be fooled when the revealed text repeats what was hidden. The exact alternative tracks hidden input positions through every pass, which needs `redactUrl`'s re-serialisation reworked.
3. **Which final bytes of a stripped terminal code to keep (cases 8 and 10).** When a terminal code is stripped, its final byte may be a letter a credential label needs (`ESC[token=…`). R79 keeps a byte that completes a label on its own, or all of a run's bytes if together they make one. That misses:
   - a label that needs some of the bytes but not the others: `p ESC(a ESC(s ESC(s ESC(x=PRIVATE` becomes `p=PRIVATE` (case 8);
   - a label judged without the separator after it: `toke ESC(n-bearer=PRIVATE` becomes `toke-bearer=PRIVATE`, because `bearer` counts though the Bearer pass needs whitespace (case 10).
   
   #81 tried, over six review rounds, to pick the one reading of the bytes that holds a label. It was dropped under R8. Every rule that chose a reading changed text another pass depends on:
   - a header's whole name (`cookie`);
   - a Basic payload, whose base64 length changes with any byte;
   - a label of the other kind (`key.bearer`).
   
   Or it chose by a measure that does not hold: a bounded window around the run, "fewer characters visible", or a key separator after the run, which may be Basic padding. Its separator check also went quadratic. The regression tests from #81 pin every shape that leaked, and `main` masks each of them.
   
   The direction is span-based masking: compute which input spans any reading of the bytes would hide, and mask their union, instead of choosing a reading. It covers cases 5, 8, 9 and 10 alike and is designed in [section S](#s-span-based-masking-planned-82) ([#82](https://github.com/OlehPendrakovskyi/vsclaw/issues/82)).
