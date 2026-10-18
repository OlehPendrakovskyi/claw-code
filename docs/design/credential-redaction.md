# Design: credential redaction

Covers roadmap item **SEC-4**: the rewrite of credential redaction (`src/core/accessInfo/redact.ts`) around stated invariants, tracked in [#63](https://github.com/OlehPendrakovskyi/vsclaw/issues/63). Unlike the other designs here, this one describes a shipped feature that is being reworked. Status: in progress. The rules below are added section by section as each part of the rework lands. Back to the [roadmap](../roadmap.md).

## Problem

`redactText` masks credentials in text that leaves the process: logs, error messages, the Overview and reports. The text is untrusted, and so is its form: terminal codes, JSON escapes at any depth, pretty-printed structures, and URLs that do not parse. The masking grew one case at a time and has had findings in the same sections over several review rounds. Under R8 it is now rewritten as the invariants below, each with the mechanism that holds it.

## T. Terminal-code stripping

A terminal code is stripped before any masking pass runs. Its final byte may be a letter that a credential label needs (`ESC[token=…`, whose `t` is the final byte), so a final byte that is a name character is marked, and each run of name characters holding marked bytes is resolved once every other code and control byte is gone (R79).

**T1. One label vocabulary.** The strip-time label check knows exactly the labels the masking passes read: `LABELS` in `redact.ts`. Each one says where it may sit in a run: anywhere (`SENSITIVE_KEY`, `CREDENTIAL_HEADER_KEY`), apart from other letters (`pass`), or as a whole word ending the run (`bearer`, `basic`, as `LABEL_WORD`). Every spelling those regexes accept beyond these (`api_key`, `access-key`, `set-cookie`) contains one of them.

**T2. T3 acts only right before a key separator.** The separator is `:` or `=`, after optional closing quotes and whitespace, raw or serialised. There, only a key or header label masks the value: `bearer` and `basic` take no value that opens with `=` or `:`. The separator is judged with the marked bytes of later runs and without them, since either may be what is left (`bearer ESC[0m=` reads `bearer =`). Anywhere else (prose, a Basic payload, a name that runs on through a tab or serialised control), the first rule's reading stands unchanged.

**T3. Right before a key separator, a reading that forms a key label adds its bytes to the first rule's.**
- R79's first rule reads the run first (`firstReading`):
  - with no marked byte kept, if that is a label;
  - else with each byte that completes a label with its neighbours on its own;
  - else with every byte, if that makes a label.
  
  It keeps bytes generously, so the other passes see the run much as it was: a header keeps its whole `cookie`, and a Basic payload keeps the characters that make it base64.
- If a key separator follows and that reading holds no key or header label, the bytes of one reading that forms one are **added** to the bytes it kept, and none of those is dropped. `p ESC(a ESC(s ESC(s ESC(x=` becomes `pass=`, and `toke ESC(n-bearer=` becomes `token-bearer=`. If the result still holds no key label, the first rule's reading stands.
- `pass` also keeps, on each side, the nearest marked byte that is no letter, if one comes before the next fixed character: `by ESC(_ pass=` becomes `by_pass=`.

### Mechanism

- `keepLabelBytes` judges the separator after each run (`separated`), on the text and on `withoutMarkedBytes`, which is built once and only when needed. `keepRunLabelBytes` takes `firstReading`'s kept bytes and, before a separator where they hold no key label, adds those `labelBytes` finds.
- `labelBytes` matches each key label with a small automaton. Its state is the set of prefix lengths matched so far, as bits: a fixed character must extend a prefix, and a marked one may extend it or be skipped. Where a bounded label may start and end is read from the nearest fixed character on each side, since every marked byte outside the match goes. The states before each character are kept, so `readingOf` finds the match's bytes going back from its end, and `keepBoundary` adds the boundary bytes.
- Each label reads the run once forward and its match once back, with constant work per character, so stripping stays linear (R64).
- A test checks T3 directly: for a fixed-seed sample of label words split by codes, in query, tab, serialised-control and spaced-separator contexts, if any reading of the final bytes hides the value, the text with its codes must too.

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
3. **Readings away from a key separator.** T3 acts only right before a key separator. Elsewhere the first rule's reading stands, as on `main`, even where another reading would mask what follows. Examples, all the same on `main`:
   - a `bearer` that only the dropped bytes form before a plain value (`token-beare ESC(r PRIVATE`);
   - a key whose name runs on through a serialised control (`my_pass ESC(w…ESC(d \nx\t=PRIVATE`, `?p ESC(a…ESC(s \tx=PRIVATE`).
   
   #81 tried wider rules over five review rounds and dropped each under R8. Each one changed text that another pass depends on: a header's name, a Basic payload, a label of the other kind. Or it chose between readings by a measure that does not hold: a bounded window around the run, or "fewer characters visible". Tracking which input spans each reading hides, and masking a span where neither covers the other, is the alternative.
