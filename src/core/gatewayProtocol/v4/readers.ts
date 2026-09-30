/**
 * Protocol v4 reader facade.
 *
 * The canonical guard/read primitives live in `core/typeGuards.ts`; this module
 * re-exports them so the v4 protocol modules (and their tests) keep importing
 * from `./readers` unchanged. Protocol-domain readers that are meaningful only
 * to v4 live here as well.
 */

export {
  MAX_TIMER_DELAY_MS,
  asNonEmptyString,
  asRecord,
  asString,
  describeJson,
  isIndexInRange,
  isOptionalString,
  isRecord,
  parseJsonRecord,
  readArray,
  readDelayMs,
  readFiniteNumber,
  readNonNegativeInteger,
  readPositiveInteger,
  readRecord,
  readString,
  readStrings,
  readText,
  readTrimmedString,
} from '../../typeGuards';
