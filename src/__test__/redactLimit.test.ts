import { STDERR_RAW_MAX_CHARS } from '../chat/ChatService';
import {
    joinBoundary,
    REDACT_MAX_CHARS,
    REDACT_WITHHELD,
    redactEndpointText,
    redactText,
    redactTextAndSecret,
    redactTextReading,
} from '../core/accessInfo/redact';

describe('redaction size limit (R64)', () => {
    const over = `token=PRIVATE ${'a'.repeat(REDACT_MAX_CHARS)}`;

    it('withholds text over the limit whole, and redacts text at the limit as usual', () => {
        expect(redactText(over)).toBe(REDACT_WITHHELD);
        const at = `token=PRIVATE\n${'a'.repeat(REDACT_MAX_CHARS - 'token=PRIVATE\n'.length)}`;
        expect(at).toHaveLength(REDACT_MAX_CHARS);
        expect(redactText(at)).toBe(`token=***\n${'a'.repeat(REDACT_MAX_CHARS - 'token=PRIVATE\n'.length)}`);
    });

    it('records withheld text as hidden whole', () => {
        const reading = redactTextReading(over);
        expect(reading.text).toBe(REDACT_WITHHELD);
        expect(reading.hidden).toEqual([[0, over.length]]);
        expect([...reading.to].every(to => to === over.length)).toBe(true);
    });

    it('withholds through every entry point that redacts free text', () => {
        expect(redactEndpointText(`https://alice:PRIVATE@host/${'a'.repeat(REDACT_MAX_CHARS)}`)).toBe(REDACT_WITHHELD);
        expect(redactTextAndSecret(`PRIVATE ${'a'.repeat(REDACT_MAX_CHARS)}`, 'PRIVATE')).toBe(REDACT_WITHHELD);
    });

    it('shows the placeholder unchanged when it is redacted again', () => {
        expect(redactText(REDACT_WITHHELD)).toBe(REDACT_WITHHELD);
        expect(redactEndpointText(REDACT_WITHHELD)).toBe(REDACT_WITHHELD);
        expect(REDACT_WITHHELD).not.toContain('***');
    });

    it('withholds both parts of a join too long to judge, whichever side is long', () => {
        // `left` may open a credential that `right` completes; unscanned, neither can be shown.
        const long = 'a'.repeat(REDACT_MAX_CHARS);
        expect(joinBoundary('https://alice:PREFIX', `${long}SUFFIX@host`)).toEqual({ left: REDACT_WITHHELD, maskRight: true });
        expect(joinBoundary(`${long} Bearer`, 'PRIVATE')).toEqual({ left: REDACT_WITHHELD, maskRight: true });
        // Parts within the limit together are judged as before.
        expect(joinBoundary('failed', 'reason')).toEqual({ left: 'failed', maskRight: false });
    });

    it('stays fast on text far over the limit', () => {
        const huge = 'token=a '.repeat(REDACT_MAX_CHARS);
        const started = performance.now();
        expect(redactText(huge)).toBe(REDACT_WITHHELD);
        expect(joinBoundary(huge, huge).maskRight).toBe(true);
        expect(performance.now() - started).toBeLessThan(1000);
    });

    it('never withholds the acpx stderr tail, which is collected up to the same size', () => {
        expect(STDERR_RAW_MAX_CHARS).toBeLessThanOrEqual(REDACT_MAX_CHARS);
    });
});
