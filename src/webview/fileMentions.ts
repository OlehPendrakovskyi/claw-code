/** One @-mention extracted from a chat draft. */
export interface FileMention {
    /** Path as typed in the mention (may be relative to the workspace). */
    path: string;
    /** 1-based start line when the mention carries a #L range. */
    lineStart?: number;
    /** 1-based end line when the mention carries a #L range. */
    lineEnd?: number;
}

/**
 * Parse `@path` / `@path#L5` / `@path#L5-10` mentions from a draft text.
 * Mentions start at word boundaries and stop at whitespace.
 */
export function parseFileMentions(text: string): FileMention[] {
    if (!text) {
        return [];
    }

    const mentionRegex = /(?:^|\s)@([^\s@]+?)(?:#L(\d+)(?:-(\d+))?)?(?=\s|$)/g;
    const mentions: FileMention[] = [];
    const seen = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(text)) !== null) {
        const path = match[1];
        if (!path) {
            continue;
        }
        const lineStart = match[2] != null ? Math.max(1, parseInt(match[2], 10)) : undefined;
        const lineEndRaw = match[3] != null ? Math.max(1, parseInt(match[3], 10)) : undefined;
        const lineEnd =
            lineEndRaw != null && lineStart != null ? Math.max(lineStart, lineEndRaw) : lineStart;
        // Dedupe on path + range so the same file with different ranges is kept.
        const key = `${path}#${lineStart ?? ''}-${lineEnd ?? ''}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        mentions.push({
            path,
            ...(lineStart !== undefined ? { lineStart, lineEnd } : {})
        });
    }

    return mentions;
}

/** Build the mention string for an editor context (path plus optional line range).
 *  Non-positive starts clamp to line 1; reversed ranges collapse to the start line. */
export function buildMention(filePath: string, lineStart?: number, lineEnd?: number): string {
    if (lineStart != null && lineEnd != null) {
        const start = Math.max(1, lineStart);
        const end = Math.max(start, lineEnd);
        if (end > start) {
            return `@${filePath}#L${start}-${end}`;
        }
        return `@${filePath}#L${start}`;
    }
    if (lineStart != null) {
        return `@${filePath}#L${Math.max(1, lineStart)}`;
    }
    return `@${filePath}`;
}
