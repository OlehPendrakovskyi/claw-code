import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder } from 'util';
import { markdownToHTML } from '@create-markdown/preview';
import { ChatService, UsageInfo } from '../chat/ChatService';
import type { GatewayChatService } from '../core/gatewayChatService';
import { EditorContext, ContextType } from './slashCommands';

/** Shared output channel for chat panel logging. */
export const log = vscode.window.createOutputChannel('OpenClaw Chat', { log: true });

/** A chat message rendered in the webview. */
export type ChatMessage =
    | { role: 'user' | 'assistant' | 'error'; content: string; html?: string }
    | {
        role: 'tool';
        entries: Array<{ title: string; status: string; details: string }>;
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

/** Read attachment files into prompt-ready text blocks, honoring optional 1-based line ranges. */
export async function readAttachments(attachments: Attachment[]): Promise<string> {
    const sections: string[] = [];

    for (const att of attachments) {
        if (att.type === 'image') {
            sections.push(`<image path="${escapeXmlAttr(att.path)}" />`);
            continue;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(att.path));
            const content = new TextDecoder().decode(bytes);
            sections.push(`<file path="${escapeXmlAttr(att.path)}">\n${sliceLineRange(content, att.lineStart, att.lineEnd)}\n</file>`);
        } catch {
            sections.push(`<file path="${escapeXmlAttr(att.path)}">\n[Could not read file]\n</file>`);
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

/** Append or update a tool-call message in a thread snapshot. */
export function appendToolMessage(
    thread: ChatThreadState,
    entry: { title: string; status: string; details: string }
): void {
    const lastMessage = thread.messages[thread.messages.length - 1];
    if (lastMessage?.role === 'tool') {
        lastMessage.entries.push(entry);
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