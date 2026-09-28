import { randomUUID } from 'crypto';

export type ContextType =
    | 'selection'
    | 'file'
    | 'diagnostics'
    | 'gitDiff'
    | 'gitStaged'
    | 'none';

export interface SlashCommand {
    name: string;
    description: string;
    icon: string;
    contextType: ContextType;
    placeholder: string;
}

export interface EditorContext {
    filePath?: string;
    fileName?: string;
    languageId?: string;
    selection?: string;
    fileContent?: string;
    diagnostics?: string;
    gitDiff?: string;
    gitStaged?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
    {
        name: 'explain',
        description: 'Explain code or concept',
        icon: '\u{1F4A1}',
        contextType: 'selection',
        placeholder: 'What should I explain?',
    },
    {
        name: 'fix',
        description: 'Fix issues in code',
        icon: '\u{1F527}',
        contextType: 'diagnostics',
        placeholder: 'Describe the issue, or leave blank to fix diagnostics',
    },
    {
        name: 'review',
        description: 'Code review',
        icon: '\u{1F50D}',
        contextType: 'gitDiff',
        placeholder: 'Any review focus? Leave blank for general review',
    },
    {
        name: 'test',
        description: 'Generate tests',
        icon: '\u{2713}',
        contextType: 'selection',
        placeholder: 'What should I test?',
    },
    {
        name: 'refactor',
        description: 'Suggest improvements',
        icon: '\u{21BB}',
        contextType: 'selection',
        placeholder: 'What to refactor? Leave blank to analyze selection',
    },
    {
        name: 'doc',
        description: 'Generate documentation',
        icon: '\u{1F4DD}',
        contextType: 'selection',
        placeholder: 'What to document?',
    },
    {
        name: 'commit',
        description: 'Generate commit message',
        icon: '\u{1F4E6}',
        contextType: 'gitStaged',
        placeholder: 'Any commit guidelines?',
    },
    {
        name: 'harden',
        description: 'Security analysis',
        icon: '\u{1F6E1}',
        contextType: 'file',
        placeholder: 'Security focus? Leave blank for full analysis',
    },
    {
        name: 'plan',
        description: 'Create an implementation plan',
        icon: '\u{1F5D3}\uFE0F',
        contextType: 'none',
        placeholder: 'What should I plan?',
    },
    {
        name: 'compact',
        description: 'Summarize and compact the conversation',
        icon: '\u{1F4E7}',
        contextType: 'none',
        placeholder: 'Any compaction focus? Leave blank for general summary',
    },
    {
        name: 'search',
        description: 'Search codebase',
        icon: '\u{1F50E}',
        contextType: 'none',
        placeholder: 'What are you looking for?',
    },
];

const COMMAND_INSTRUCTIONS: Record<string, string> = {
    explain:
        'Explain the following code clearly and concisely. Cover what it does, how it works, and any notable patterns or potential issues.',
    fix:
        'Identify and fix the issues in the following code. Show the corrected code and explain each fix.',
    review:
        'Perform a thorough code review. Check for bugs, security issues, performance problems, and style. Provide actionable feedback.',
    test:
        'Generate comprehensive tests for the following code. Cover happy paths, edge cases, and error conditions. Use the project\'s existing test framework if detectable.',
    refactor:
        'Suggest refactoring improvements for the following code. Focus on readability, maintainability, and performance. Show the refactored code.',
    doc:
        'Generate clear, complete documentation for the following code. Include descriptions, parameter docs, return values, and usage examples where appropriate.',
    commit:
        'Generate a concise, conventional commit message for the following staged changes. Use the format: type(scope): description. Include a body if the changes are complex.',
    harden:
        'Perform a security analysis of the following code. Identify vulnerabilities, insecure patterns, and suggest hardening improvements with corrected code.',
    search:
        'Search the codebase to answer the following question.',
    plan:
        'Create a step-by-step implementation plan for the following request. Break the work into ordered, verifiable tasks and note dependencies and risks. Do not write code yet.',
    compact:
        'Summarize the conversation so far into a compact context handoff: key decisions, current state, open questions, and next steps. Keep it concise.',
};

/** Per-field UTF-8 caps for editor context: the acpx transport passes the
 *  whole prompt as ONE execve argument (MAX_ARG_STRLEN, 128 KiB on Linux), so
 *  code + diagnostics must leave room for attachments and the system prompt. */
export const CONTEXT_CODE_MAX_BYTES = 32 * 1024;
export const CONTEXT_DIAGNOSTICS_MAX_BYTES = 8 * 1024;

export function escapeXmlAttr(str: string): string {
    return str.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Frame `body` in an element whose name carries a fresh random id. The body
 *  is embedded verbatim (the prompt has no XML parser, so escaping would reach
 *  the model altered); since the id is never derived from content, embedded
 *  text cannot forge the closing tag. `<tag>-<uuid>` is a valid XML NCName. */
export function frameTaggedBlock(tag: string, attributes: Record<string, string>, body: string): string {
    const name = `${tag}-${randomUUID()}`;
    const attrs = Object.entries(attributes)
        .map(([key, value]) => ` ${key}="${escapeXmlAttr(value)}"`)
        .join('');
    return `<${name}${attrs}>\n${body}\n</${name}>`;
}

function frameContextField(label: string, value: string, maxBytes: number): string {
    const truncated = Buffer.byteLength(value, 'utf8') > maxBytes;
    const attributes: Record<string, string> = { label };
    if (truncated) {
        attributes.truncated = `first ${maxBytes} bytes kept`;
    }
    return '\n' + frameTaggedBlock('context', attributes, keepUtf8Head(value, maxBytes));
}

function frameCode(label: string, value: string): string {
    return frameContextField(label, value, CONTEXT_CODE_MAX_BYTES);
}

function formatContext(ctx: EditorContext, contextType: ContextType): string {
    const parts: string[] = [];

    if (ctx.filePath) {
        parts.push(`File: ${ctx.filePath}`);
    }
    if (ctx.languageId) {
        parts.push(`Language: ${ctx.languageId}`);
    }

    switch (contextType) {
        case 'selection':
            if (ctx.selection) {
                parts.push(frameCode('Selected Code', ctx.selection));
            } else if (ctx.fileContent) {
                parts.push(frameCode('File Content', ctx.fileContent));
            }
            break;
        case 'file':
            if (ctx.fileContent) {
                parts.push(frameCode('File Content', ctx.fileContent));
            }
            break;
        case 'diagnostics':
            if (ctx.selection) {
                parts.push(frameCode('Code', ctx.selection));
            } else if (ctx.fileContent) {
                parts.push(frameCode('File Content', ctx.fileContent));
            }
            if (ctx.diagnostics) {
                parts.push(frameContextField('Diagnostics', ctx.diagnostics, CONTEXT_DIAGNOSTICS_MAX_BYTES));
            }
            break;
        case 'gitDiff':
            if (ctx.gitDiff) {
                parts.push(frameCode('Git Diff', ctx.gitDiff));
            } else if (ctx.fileContent) {
                parts.push(frameCode('File Content', ctx.fileContent));
            }
            break;
        case 'gitStaged':
            if (ctx.gitStaged) {
                parts.push(frameCode('Staged Changes', ctx.gitStaged));
            }
            break;
        case 'none':
            break;
    }

    return parts.join('\n');
}

/** Maximum UTF-8 bytes of conversation transcript /compact may embed; /compact
 *  carries no editor context, so this plus attachments fits the acpx argv. */
export const COMPACT_TRANSCRIPT_MAX_BYTES = 64 * 1024;

/** The first at most `maxBytes` UTF-8 bytes of `input`, ending on a code
 *  point boundary so the result stays valid UTF-8. */
export function keepUtf8Head(input: string, maxBytes: number): string {
    const encoded = Buffer.from(input, 'utf8');
    if (encoded.length <= maxBytes) {
        return input;
    }
    let end = Math.max(0, maxBytes);
    // A continuation byte at the cut belongs to a code point that started
    // before it; back up to that lead byte instead of splitting it.
    while (end > 0 && (encoded[end] & 0xC0) === 0x80) {
        end -= 1;
    }
    return encoded.subarray(0, end).toString('utf8');
}

/** The last at most `maxBytes` UTF-8 bytes of `input`, starting on a code
 *  point boundary so the result stays valid UTF-8. */
export function keepUtf8Tail(input: string, maxBytes: number): string {
    const encoded = Buffer.from(input, 'utf8');
    if (encoded.length <= maxBytes) {
        return input;
    }
    let start = encoded.length - Math.max(0, maxBytes);
    // A continuation byte at the cut belongs to a code point that started
    // before it; skip to the next lead byte instead of splitting it.
    while (start < encoded.length && (encoded[start] & 0xC0) === 0x80) {
        start += 1;
    }
    return encoded.subarray(start).toString('utf8');
}

function frameTranscript(transcript: string): string {
    // The oldest turns are the ones dropped when it exceeds the cap.
    const trimmed = Buffer.byteLength(transcript, 'utf8') > COMPACT_TRANSCRIPT_MAX_BYTES;
    const attributes: Record<string, string> = { label: 'Conversation So Far' };
    if (trimmed) {
        attributes.truncated = `earliest turns omitted; last ${COMPACT_TRANSCRIPT_MAX_BYTES} bytes kept`;
    }
    return '\n' + frameTaggedBlock('conversation', attributes, keepUtf8Tail(transcript, COMPACT_TRANSCRIPT_MAX_BYTES));
}

export function buildSlashPrompt(
    commandName: string,
    userText: string,
    context: EditorContext,
    transcript?: string
): string {
    const cmd = SLASH_COMMANDS.find(c => c.name === commandName);
    if (!cmd) {
        return userText;
    }

    const instruction = COMMAND_INSTRUCTIONS[commandName] ?? '';
    const contextBlock = formatContext(context, cmd.contextType);

    const sections: string[] = [];
    if (instruction) {
        sections.push(instruction);
    }
    if (transcript) {
        // Compaction must see the conversation it summarizes: the acpx
        // transport starts a fresh exec per send, so without this block the
        // command has no prior turns to compress.
        sections.push(frameTranscript(transcript));
    }
    if (contextBlock) {
        sections.push(contextBlock);
    }
    if (userText.trim()) {
        sections.push(`User request: ${userText.trim()}`);
    }

    return sections.join('\n\n');
}

export function findCommand(name: string): SlashCommand | undefined {
    return SLASH_COMMANDS.find(c => c.name === name);
}

export function filterCommands(query: string): SlashCommand[] {
    const q = query.toLowerCase();
    return SLASH_COMMANDS.filter(c => c.name.startsWith(q));
}
