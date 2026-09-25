/**
 * Claw Code — hardening command parsing.
 *
 * The `openclaw.hardening.command` setting is workspace-configurable (a repo
 * can ship it via .vscode/settings.json), so it must never be interpolated
 * into a shell. We parse it into an executable + argument vector and reject
 * shell metacharacters outright: the setting is meant to name one executable
 * with plain arguments, and anything else is treated as invalid.
 */

export type ParsedCommand = {
    executable: string;
    args: string[];
};

/** Characters that have no legitimate use in this setting and enable shell abuse. */
const SHELL_METACHARS = /[;&|$`<>()\n\r]/;

/**
 * Parse a hardening command string into an argv vector.
 * Quote-aware (single/double quotes), rejects shell metacharacters.
 * Returns null when the string is empty, unbalanced, or contains metachars.
 */
export function splitHardeningCommand(command: string): { executable: string; args: string[] } | null {
    const trimmed = command.trim();
    if (!trimmed) return null;

    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let hasToken = false;

    for (const ch of trimmed) {
        if (SHELL_METACHARS.test(ch)) {
            return null;
        }
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else {
                current += ch;
            }
            hasToken = true;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            hasToken = true;
            continue;
        }
        if (ch === ' ' || ch === '\t') {
            if (hasToken) {
                tokens.push(current);
                current = '';
                hasToken = false;
            }
            continue;
        }
        current += ch;
        hasToken = true;
    }
    if (quote) return null; // unbalanced quote
    if (hasToken) tokens.push(current);

    if (tokens.length === 0) return null;
    return { executable: tokens[0], args: tokens.slice(1) };
}