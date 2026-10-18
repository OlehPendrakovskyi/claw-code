# Design: credential redaction

Covers roadmap item **SEC-4**: the rewrite of credential redaction (`src/core/accessInfo/redact.ts`) around stated invariants, tracked in [#63](https://github.com/OlehPendrakovskyi/vsclaw/issues/63). Unlike the other designs here, this one describes a shipped feature that is being reworked. Status: in progress. The rules below are added section by section as each part of the rework lands. Back to the [roadmap](../roadmap.md).

## Problem

`redactText` masks credentials in text that leaves the process: logs, error messages, the Overview and reports. The text is untrusted, and so is its form: terminal codes, JSON escapes at any depth, pretty-printed structures, and URLs that do not parse. The masking grew one case at a time and has had findings in the same sections over several review rounds. Under R8 it is now rewritten as the invariants below, each with the mechanism that holds it.

## T. Terminal-code stripping

A terminal code is stripped before any masking pass runs. Its final byte may be a letter that a credential label needs (`ESC[token=…`, whose `t` is the final byte), so a final byte that is a name character is marked, and each run of name characters holding marked bytes is resolved once every other code and control byte is gone (R79).

**T1. One label vocabulary.** The strip-time label check knows exactly the labels the masking passes read: `LABELS` in `redact.ts`. Each one says where it may sit in a run: anywhere (`SENSITIVE_KEY`, `CREDENTIAL_HEADER_KEY`), apart from other letters (`pass`), or as a whole word ending the run (`bearer`, `basic`, as `LABEL_WORD`). Every spelling those regexes accept beyond these (`api_key`, `access-key`, `set-cookie`) contains one of them.

**T2. A label is judged with the separator after it.** A key or header label counts before any separator: a query name runs on through a tab or other characters (`?toke ESC(n \tx=`), and a key through a serialised control (`toke ESC(n \bx=`). `bearer` and `basic` count only before whitespace that has no key separator after it, as the Bearer and Basic passes need (`bearer =x` opens nothing), or at the end of the text.

**T3. The earlier rule's reading stands wherever it holds a label that acts there; otherwise the bytes of one reading that does are kept, and only those.**
- R79's first rule reads the run first (`firstReading`):
  - with no marked byte kept, if that is a label;
  - else with each byte that completes a label with its neighbours on its own;
  - else with every byte, if that makes a label.
  
  It reads every kind of label at once and keeps bytes generously, so the other passes see the run much as it was: a header keeps its whole `cookie`, and a Basic credential keeps the characters that make it base64. Wherever its output holds a label that acts before the separator after the run (T2), it stands.
- Otherwise, if some reading forms a key label, the bytes of one such reading stay and no others: `p ESC(a ESC(s ESC(s ESC(x=` becomes `pass=`, and `toke ESC(n-bearer=` becomes `token-bearer=`. Failing that, the same holds for a word label.
- A bounded label also keeps, on each side, the nearest marked byte that is no letter (for `pass`) or no word character (before `bearer`, `basic`), if one comes before the next fixed character: `by ESC(_ pass=` becomes `by_pass=`. The masking passes read a name on past the run (`pass ESC(0 \nx`), so a boundary the run seems to have may be none.
- After a tab or a serialised control with no key separator after it, one pass reads the name on with a letter (a key: `pass\nx` reads as `passnx`), and another stops it there (a query name: `?pass\tx=` holds a bounded `pass`). A key label counts there only if it holds as though a letter followed the run, the earlier rule's reading included. One that holds only where the name stops is the last resort.
- A word that only the dropped bytes would form, where the run already holds a key, is not looked for (open question 3).

### Mechanism

- `keepRunLabelBytes` reads T2 from the text right after the run (`SPACE_AT`, `KEY_SEPARATOR_AT`, `NAME_GOES_ON_AT`). It takes `firstReading` wherever that holds a label acting there, judged with the masking passes' own regexes, and otherwise asks `labelBytes`: keys, then words, then keys that hold only where the name stops.
- `labelBytes` matches each allowed label with a small automaton. Its state is the set of prefix lengths matched so far, as bits: a fixed character must extend a prefix, and a marked one may extend it or be skipped. Where a bounded label may start and end is read from the nearest fixed character on each side, since every marked byte outside the match goes. The states before each character are kept, so `readingOf` finds the match's bytes going back from its end, and `keepBoundary` adds the boundary bytes.
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
3. **A word that only the dropped bytes would form, next to a key.** When the earlier rule's reading holds a key label, it stands, even where only a `bearer` or `basic` formed by bytes it drops would mask what follows. `token-beare ESC(r PRIVATE` and `ESC(t…ESC(r PRIVATE` keep `PRIVATE`, as `main` does. #81 tried three ways to choose between the kinds and dropped each under R8:
   - holding one label of each kind at once, which broke headers and Basic credentials that need the bytes the minimal reading drops;
   - redacting both readings over a window, which failed because what decides can lie past any window (`\\` repeated, then `tx=`), and "fewer characters visible" is not "the value hidden";
   - always keeping the word before whitespace.
   
   Tracking which input spans each reading hides, and masking a span where neither covers the other, is the alternative.
