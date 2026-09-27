import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp, constants as fsConstants } from 'fs';
import { TextDecoder } from 'util';
import { markdownToHTML } from '@create-markdown/preview';
import { ChatService, UsageInfo } from '../chat/ChatService';
import type { GatewayChatService } from '../core/gatewayChatService';
import { EditorContext, ContextType } from './slashCommands';
import { randomUUID } from 'crypto';

/** Shared output channel for chat panel logging. */
export const log = vscode.window.createOutputChannel('OpenClaw Chat', { log: true });

/** A chat message rendered in the webview. */
export type ChatMessage =
    | { role: 'user' | 'assistant' | 'error'; content: string; html?: string }
    | {
        role: 'tool';
        entries: Array<{ title: string; status: string; details: string; id?: string }>;
    };

/** An attachment referenced by a chat thread. */
export type Attachment = { name: string; path: string; type: 'file' | 'image'; previewUri?: string; lineStart?: number; lineEnd?: number };

/** Full mutable state of one chat thread. */
export type ChatThreadState = {
    id: string;
    index: number;
    title: string;
    messages: ChatMessage[];
    pendingAssistantText: string;
    pendingAttachments: Attachment[];
    currentChatType: string;
    currentModel: string;
    permissionState: string;
    isStreaming: boolean;
    status: 'idle' | 'running' | 'complete' | 'error' | 'cancelled';
    source: string;
    contextTokens: number;
    contextMax: number;
    lastUsage: UsageInfo | null;
    service: ChatService;
    /** Backend transport of the most recent send (legacy or gateway); lifecycle actions target it. */
    transportBackend?: ChatService | GatewayChatService;
    /** Gateway session key bound to this thread (agent/session picker); scopes lifecycle actions. */
    sessionKey?: string;
    /** Monotonic generation for gateway event delivery: rebound/cancelled
     *  threads bump it so sinks captured by an earlier run stop delivering. */
    eventEpoch: number;
    /** Monotonic generation for persistent transcript sinks: bumped on
     *  rebind/reset only (never per run), so a session's transcript callback
     *  keeps delivering events across successive runs on the same binding. */
    bindingEpoch: number;
    /** Monotonic generation of openSession requests on this thread: bumped on
     *  every open, so an earlier async open continuation can detect that a
     *  newer open superseded it (the session key alone cannot — it still
     *  holds the previous key until the open assigns the new one). */
    openGeneration: number;
    /** Generation of the openSession currently rebinding this thread, or null
     *  when no open is in flight. Sends are rejected while set: the shared
     *  gateway session switches before the rebinding lands, so a concurrent
     *  send would target the previous key and deliver into the newly opened
     *  conversation. Ownership-checked on clear so a superseded open's
     *  continuation cannot unset a newer open's marker. */
    openInFlightGen: number | null;
};

/** Serializable snapshot of a thread sent to the webview. */
export type ThreadSnapshot = {
    id: string;
    index: number;
    title: string;
    messages: Array<Record<string, unknown>>;
    pendingAssistantText: string;
    pendingAttachments: Attachment[];
    currentChatType: string;
    currentModel: string;
    permissionState: string;
    isStreaming: boolean;
    status: 'idle' | 'running' | 'complete' | 'error' | 'cancelled';
    source: string;
    contextTokens: number;
    contextMax: number;
    lastUsage: UsageInfo | null;
};

/** Post a message to every live webview target. */
export function postToAll(
    views: Array<vscode.Webview | undefined>,
    message: Record<string, unknown>
): void {
    for (const view of views) {
        view?.postMessage(message);
    }
}

/** Build webview snapshots for the given thread ids. */
export function getThreadSnapshots(
    threads: Map<string, ChatThreadState>,
    visibleThreadIds: string[]
): ThreadSnapshot[] {
    return visibleThreadIds
        .map(id => threads.get(id))
        .filter((thread): thread is ChatThreadState => Boolean(thread))
        .map(thread => ({
            id: thread.id,
            index: thread.index,
            title: thread.title,
            messages: thread.messages.map(message => ({ ...message })),
            pendingAssistantText: thread.pendingAssistantText,
            pendingAttachments: [...thread.pendingAttachments],
            currentChatType: thread.currentChatType,
            currentModel: thread.currentModel,
            permissionState: thread.permissionState,
            isStreaming: thread.isStreaming,
            status: thread.status,
            source: thread.source,
            contextTokens: thread.contextTokens,
            contextMax: thread.contextMax,
            lastUsage: thread.lastUsage ? { ...thread.lastUsage } : null
        }));
}

/** Add preview URIs to thread attachments for webview rendering. */
export function enrichAttachmentsForWebview(
    snapshots: ThreadSnapshot[],
    webview: vscode.Webview
): ThreadSnapshot[] {
    return snapshots.map(t => ({
        ...t,
        pendingAttachments: t.pendingAttachments.map(att => {
            if (att.type !== 'image') { return att; }
            try {
                return { ...att, previewUri: webview.asWebviewUri(vscode.Uri.file(att.path)).toString() };
            } catch {
                return att;
            }
        })
    }));
}

/** Convert markdown text to sanitized HTML for the webview. */
export async function renderMarkdown(text: string): Promise<string> {
    try {
        return await markdownToHTML(text, { sanitize: true });
    } catch (err) {
        log.warn('markdownToHTML failed, using fallback', err);
        return escapeHtml(text);
    }
}

/** Escape HTML-significant characters in plain text. */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Escape glob-significant characters in a search pattern. */
export function escapeGlob(str: string): string {
    return str.replace(/[[\]{}()*?!\\]/g, '\\$&');
}

export function escapeXmlAttr(str: string): string {
    return str.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Frame a file section with a per-section unique closing tag. File data is
 *  embedded verbatim (byte-faithful): a `</file id="...">` sequence forged by
 *  file content cannot terminate the section because the random id is
 *  generated per section and never derived from file bytes. */
function frameFileBody(path: string, content: string): string {
    const id = randomUUID();
    return `<file path="${escapeXmlAttr(path)}" id="${id}">\n${content}\n</file id="${id}">`;
}

/** Returns the canonical attachment path only when it still resolves to the
 *  validated location (rejects a post-validation symlink swap), or null. */
async function safeCanonicalPath(p: string): Promise<string | null> {
    try {
        const real = await fsp.realpath(p);
        // Attachments store the canonical realpath, so a still-valid file
        // resolves to exactly the stored spelling on any filesystem. A
        // case-folded comparison gated on process.platform would also accept
        // a swap to a differently-spelled different file on case-sensitive
        // volumes (e.g. macOS APFS case-sensitive), so any mismatch —
        // including case-only — means the path now resolves elsewhere and is
        // dropped.
        return real === p ? real : null;
    } catch {
        return null;
    }
}

/** Read attachment files into prompt-ready text blocks, honoring optional 1-based line ranges.
 *
 *  TOCTOU hardening: attachments carry canonical paths validated at mention
 *  time, but the filesystem can change before this read, so every read goes
 *  through an opened handle instead of a re-opened path string:
 *  1. Re-verify realpath up front — a changed path means a symlink was
 *     swapped in since validation (reject).
 *  2. Open the final component with O_NOFOLLOW (POSIX) so a last-instant
 *     leaf swap cannot redirect the read outside the workspace.
 *  3. Compare the opened handle's identity (dev/ino) against a fresh lstat
 *     of the path. This covers Windows too, where O_NOFOLLOW is unavailable:
 *     a symlink/junction swapped in at the final component yields a mismatch
 *     instead of foreign content.
 *  4. Re-canonicalize the path after the read and discard on any drift, which
 *     catches an intermediate-directory swap that happened after realpath but
 *     before open.
 *  The residual window — a swap that lands before open and reverts between
 *  the identity check and post-read re-canonicalization — is not closable
 *  from userspace without directory-handle (openat) support; every other
 *  interleaving above is detected and the content is discarded.
 */
export async function readAttachments(attachments: Attachment[]): Promise<string> {
    const sections: string[] = [];

    for (const att of attachments) {
        // Image paths are handed to a downstream reader, so the same
        // re-canonicalization as text attachments applies before emitting: a
        // path swapped for a symlink after mention validation is dropped.
        if (att.type === 'image') {
            const real = await safeCanonicalPath(att.path);
            if (real === null) {
                sections.push('[Could not read file]');
                continue;
            }
            sections.push(`<image path="${escapeXmlAttr(real)}" />`);
            continue;
        }
        try {
            const real = await fsp.realpath(att.path);
            // The stored path is canonicalized at attachment time, so any
            // realpath mismatch — including a case-only spelling difference,
            // which a swap can exploit on case-sensitive volumes — means the
            // stored path now resolves elsewhere and must be dropped.
            if (real !== att.path) {
                sections.push(frameFileBody(att.path, '[Could not read file]'));
                continue;
            }
            const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
            const handle = await fsp.open(real, fsConstants.O_RDONLY | noFollow);
            try {
                const opened = await handle.stat();
                const current = await fsp.lstat(real);
                if (opened.dev !== current.dev || opened.ino !== current.ino) {
                    throw new Error('attachment path changed during read');
                }
                const bytes = await handle.readFile();
                const content = new TextDecoder().decode(bytes);
                const realAfter = await fsp.realpath(real);
                if (realAfter !== real) {
                    throw new Error('attachment path changed during read');
                }
                sections.push(frameFileBody(att.path, sliceLineRange(content, att.lineStart, att.lineEnd)));
            } finally {
                await handle.close();
            }
        } catch {
            sections.push(frameFileBody(att.path, '[Could not read file]'));
        }
    }

    return sections.join('\n\n');
}

/** Slice a file body to a 1-based inclusive line range when the mention carries a #L range.
 *  A missing range returns the whole body; a non-positive start clamps to line 1;
 *  reversed ranges (end < start) collapse to the start line; CRLF is handled by
 *  splitting on `/\r?\n/` so Windows line endings do not pollute slices. */
export function sliceLineRange(content: string, lineStart?: number, lineEnd?: number): string {
    if (lineStart == null) {
        return content;
    }
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, lineStart) - 1;
    const end = Math.min(lines.length, Math.max(1, Math.max(lineStart, lineEnd ?? lineStart)));
    if (start >= lines.length) {
        return '';
    }
    return lines.slice(start, end).join('\n');
}

/** Append or update a tool-call message in a thread snapshot.
 *  Entries carrying an id update the matching entry in the last tool message
 *  (lifecycle transitions like running→done stay on one row); entries without
 *  an id are always appended. */
export function appendToolMessage(
    thread: ChatThreadState,
    entry: { title: string; status: string; details: string; id?: string }
): void {
    const lastMessage = thread.messages[thread.messages.length - 1];
    if (lastMessage?.role === 'tool') {
        const existing = entry.id != null
            ? lastMessage.entries.findIndex(e => e.id === entry.id)
            : -1;
        if (existing >= 0) {
            lastMessage.entries[existing] = entry;
        } else {
            lastMessage.entries.push(entry);
        }
        return;
    }

    thread.messages.push({
        role: 'tool',
        entries: [entry]
    });
}

/** Handle a webview file-search request, preferring open editors then ripgrep. */
export async function handleFileSearch(query: string, webview: vscode.Webview, cwd: string): Promise<void> {
    const limit = 15;
    type FileSearchResult = {name: string; path: string; relativePath: string};

    if (!query) {
        const openFiles: FileSearchResult[] = [];
        try {
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (tab.input instanceof vscode.TabInputText) {
                        const uri = tab.input.uri;
                        openFiles.push({
                            name: path.basename(uri.fsPath),
                            path: uri.fsPath,
                            relativePath: cwd ? path.relative(cwd, uri.fsPath) : uri.fsPath
                        });
                    }
                }
            }
        } catch {
        }

        if (openFiles.length > 0) {
            webview.postMessage({ type: 'fileSearchResults', files: openFiles.slice(0, limit) });
            return;
        }
    }

    const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}';
    const lowerQuery = query.trim().toLowerCase();
    const escaped = lowerQuery ? escapeGlob(query) : '';
    const pattern = escaped ? `**/*${escaped}*` : '**/*';
    const toFileResult = (uri: vscode.Uri): FileSearchResult => ({
        name: path.basename(uri.fsPath),
        path: uri.fsPath,
        relativePath: cwd ? path.relative(cwd, uri.fsPath) : uri.fsPath
    });
    const matchesQuery = (file: FileSearchResult): boolean => (
        !lowerQuery ||
        file.name.toLowerCase().includes(lowerQuery) ||
        file.relativePath.toLowerCase().includes(lowerQuery)
    );
    const scoreFile = (file: FileSearchResult): number => {
        if (!lowerQuery) {
            return file.relativePath.length;
        }
        const lowerName = file.name.toLowerCase();
        const lowerPath = file.relativePath.toLowerCase();
        if (lowerName.startsWith(lowerQuery)) {
            return 0;
        }
        if (lowerName.includes(lowerQuery)) {
            return 1;
        }
        if (lowerPath.startsWith(lowerQuery)) {
            return 2;
        }
        return 3;
    };
    const sortFiles = (files: FileSearchResult[]): FileSearchResult[] => files.sort((a, b) => {
        const scoreDiff = scoreFile(a) - scoreFile(b);
        if (scoreDiff !== 0) {
            return scoreDiff;
        }
        return a.relativePath.length - b.relativePath.length;
    });
    const appendUniqueFiles = (target: FileSearchResult[], files: FileSearchResult[]): void => {
        const seen = new Set(target.map(file => file.path));
        for (const file of files) {
            if (seen.has(file.path)) {
                continue;
            }
            seen.add(file.path);
            target.push(file);
        }
    };

    const files: FileSearchResult[] = [];
    const uris = await vscode.workspace.findFiles(pattern, exclude, 30);
    appendUniqueFiles(files, uris.map(toFileResult).filter(matchesQuery));

    if (lowerQuery && files.length < limit) {
        const fallbackUris = await vscode.workspace.findFiles('**/*', exclude);
        appendUniqueFiles(files, fallbackUris.map(toFileResult).filter(matchesQuery));
    }

    webview.postMessage({ type: 'fileSearchResults', files: sortFiles(files).slice(0, limit) });
}

/** Gather editor context (selection, diagnostics, file) for slash commands. */
export async function gatherEditorContext(
    contextType: ContextType,
    runGitFn: (args: string) => Promise<string>
): Promise<EditorContext> {
    const editor = vscode.window.activeTextEditor;
    const ctx: EditorContext = {};

    if (editor) {
        ctx.filePath = vscode.workspace.asRelativePath(editor.document.uri);
        ctx.fileName = path.basename(editor.document.uri.fsPath);
        ctx.languageId = editor.document.languageId;

        const sel = editor.selection;
        if (!sel.isEmpty) {
            ctx.selection = editor.document.getText(sel);
        }
    }

    switch (contextType) {
        case 'selection':
            if (!ctx.selection && editor) {
                ctx.fileContent = editor.document.getText();
            }
            break;
        case 'file':
            if (editor) {
                ctx.fileContent = editor.document.getText();
            }
            break;
        case 'diagnostics':
            if (!ctx.selection && editor) {
                ctx.fileContent = editor.document.getText();
            }
            if (editor) {
                const diags = vscode.languages.getDiagnostics(editor.document.uri);
                if (diags.length > 0) {
                    ctx.diagnostics = diags
                        .map(d => {
                            const sev = vscode.DiagnosticSeverity[d.severity];
                            return `[${sev}] Line ${d.range.start.line + 1}: ${d.message}`;
                        })
                        .join('\n');
                }
            }
            break;
        case 'gitDiff':
            ctx.gitDiff = await runGitFn('diff');
            if (!ctx.gitDiff && editor) {
                ctx.fileContent = editor.document.getText();
            }
            break;
        case 'gitStaged':
            ctx.gitStaged = await runGitFn('diff --staged');
            break;
        case 'none':
            break;
    }

    return ctx;
}