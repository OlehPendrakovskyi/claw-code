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
        const lineStart = match[2] ? parseInt(match[2], 10) : undefined;
        const lineEndRaw = match[3] ? parseInt(match[3], 10) : undefined;
        const lineEnd = lineEndRaw ?? lineStart;
        // Dedupe on path + range so the same file with different ranges is kept.
        const key = `${path}#${lineStart ?? ''}-${lineEnd ?? ''}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        mentions.push({
            path,
            ...(lineStart ? { lineStart, lineEnd } : {})
        });
    }

    return mentions;
}

/** Build the mention string for an editor context (path plus optional line range). */
export function buildMention(filePath: string, lineStart?: number, lineEnd?: number): string {
    if (lineStart && lineEnd && lineEnd > lineStart) {
        return `@${filePath}#L${lineStart}-${lineEnd}`;
    }
    if (lineStart) {
        return `@${filePath}#L${lineStart}`;
    }
    return `@${filePath}`;
}
