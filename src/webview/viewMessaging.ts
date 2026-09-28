import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { promises as fsp, constants as fsConstants } from 'fs';

/** O_NONBLOCK on POSIX, absent on Windows: a blocking O_RDONLY open on a
 *  FIFO (named pipe) parks the caller until a writer appears, so every
 *  attachment open combines it with O_NOFOLLOW and lets the regular-file
 *  checks below reject special files after a non-blocking open. */
const openNonBlock = process.platform === 'win32' ? 0 : fsConstants.O_NONBLOCK;
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

/** Frame a file section with a per-section unique element name. The body is
 *  embedded byte/text-faithful (never entity-escaped: the prompt path has no
 *  XML parser, so escaping would reach the model altered). Injection is
 *  still impossible: the random id is generated per section and never
 *  derived from file bytes, so file content cannot forge the closing tag;
 *  the id is carried in the element name itself — closing tags cannot carry
 *  attributes, so `</file id="...">` would be rejected by any XML-conformant
 *  parser — and `file-<uuid>` is a valid XML NCName (dashes are legal; the
 *  leading letter keeps the name from starting with a digit). */
function frameFileBody(path: string, content: string): string {
    const id = randomUUID();
    return `<file-${id} path="${escapeXmlAttr(path)}">\n${content}\n</file-${id}>`;
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

/** Resolve the location an opened handle actually refers to. Linux exposes
 *  the fd link at /proc/self/fd; other POSIX systems (macOS/BSD) mount the
 *  same handle view at /dev/fd (fdescfs), so both are tried and a link that
 *  fails to resolve to a real path yields null. Unlike realpath of the
 *  stored path, the fd link is anchored to the opened inode, so a parent
 *  directory swapped before open and restored afterwards still shows the
 *  swap: the opened file's true path differs from the stored canonical
 *  path and the content must be discarded. */
async function openedHandlePath(handle: fsp.FileHandle): Promise<string | null> {
    if (process.platform === 'win32') {
        return null;
    }
    for (const dir of ['/proc/self/fd', '/dev/fd']) {
        try {
            const real = await fsp.realpath(`${dir}/${handle.fd}`);
            // A char-device fallback (fdescfs not resolving to the target)
            // echoes the fd path itself instead of the file path; such a
            // result carries no location information and must not reject a
            // valid attachment.
            if (real === `${dir}/${handle.fd}`) {
                continue;
            }
            return real;
        } catch {
            // try the next handle root
        }
    }
    return null;
}

/** Mime type for an image attachment path, by extension. */
function imageMimeByPath(p: string): string {
    const ext = path.extname(p).toLowerCase();
    switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.webp': return 'image/webp';
        case '.bmp': return 'image/bmp';
        case '.svg': return 'image/svg+xml';
        case '.ico': return 'image/vnd.microsoft.icon';
        case '.tif':
        case '.tiff': return 'image/tiff';
        default: return 'application/octet-stream';
    }
}

/** Read an image attachment through the verified handle and return a data URI.
 *
 *  Extends verifyStableImagePath's checks (canonical path, O_NOFOLLOW open,
 *  dev/ino match, fd-link location) with the trusted-side read: the bytes are
 *  read from the verified handle and re-canonicalization is re-checked after
 *  the read, so the emitted content is exactly what was validated. Returns
 *  null when any check fails.
 *
 *  Size is bounded before and after the read: a large user-selected image
 *  would otherwise be base64-expanded in memory with no limit, spike memory,
 *  and make the prompt exceed the Gateway's maximum payload — files over
 *  MAX_IMAGE_BYTES are rejected instead (stat before read keeps the expansion
 *  from even starting; the post-read length check closes the swap window). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Cap for text attachment reads: bounds the transfer itself so a file that
 *  grows after stat() cannot be loaded in full before any size check. */
const ATTACHMENT_TEXT_MAX_BYTES = 10 * 1024 * 1024;

/** Cap for text attachments on CLI transports (`imageMode: 'tempFile'`): the
 *  whole assembled prompt travels as a single execve argument, and the
 *  per-argument limit (MAX_ARG_STRLEN, ~128 KiB on Linux) is far below the
 *  10 MiB inline cap — a larger text attachment would fail the spawn with
 *  E2BIG, so it is rejected up front instead of bricking the send. */
const ATTACHMENT_TEXT_ARG_MAX_BYTES = 64 * 1024;

/** Aggregate budget over all attachments in one send, counted in the encoded
 *  form that actually travels: base64 for images (4/3 of raw bytes), raw text
 *  for text files. Per-file limits alone do not bound the total, so several
 *  allowed 10 MiB images (~13.3 MiB base64 each) could exceed the Gateway's
 *  maximum payload while everything was already materialized in memory.
 *  Set below the Gateway's 25 MiB payload cap so prompt framing and history
 *  still fit alongside the attachments. The budget only bounds attachment
 *  bytes: the caller appends the base prompt (which a `/compact` send can
 *  fill with the full transcript) after this function returns, so callers
 *  pass `reservedPromptBytes` to subtract the final prompt's size plus a
 *  framing slack from the budget — otherwise a large enough prompt plus a
 *  fully-budgeted attachment set exceeds the transport's maximum payload
 *  and the send fails despite passing every check here. */
const ATTACHMENT_TOTAL_MAX_BYTES = 20 * 1024 * 1024;

/** Slack subtracted with the reserved prompt bytes so RPC framing, message
 *  history, and per-section decoration around the attachments also fit
 *  under the transport's payload cap. */
export const ATTACHMENT_PROMPT_FRAMING_RESERVE_BYTES = 1024 * 1024;

/** Read from an opened handle until EOF or the byte budget is exhausted.
 *
 *  A single FileHandle.read() is not guaranteed to fill the requested buffer:
 *  regular files can return a short read before EOF, so a one-shot read can
 *  accept a truncated file or let a file that grew past the cap slip through
 *  (the short result lands under the limit). Loop until EOF or maxBytes + 1
 *  bytes are collected, so callers can reject anything above maxBytes and
 *  otherwise get the byte-faithful contents. */
async function readBounded(handle: fsp.FileHandle, maxBytes: number): Promise<Buffer> {
    const limit = maxBytes + 1;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < limit) {
        const chunk = Buffer.alloc(limit - total);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
        if (bytesRead === 0) {
            break;
        }
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
    }
    return Buffer.concat(chunks, total);
}

async function readVerifiedImageBytes(p: string): Promise<Buffer | null> {
    if (await safeCanonicalPath(p) === null) {
        return null;
    }
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    let handle: fsp.FileHandle;
    try {
        handle = await fsp.open(p, fsConstants.O_RDONLY | noFollow | openNonBlock);
    } catch {
        return null;
    }
    try {
        const opened = await handle.stat();
        if (opened.size > MAX_IMAGE_BYTES) {
            return null;
        }
        const current = await fsp.lstat(p);
        if (opened.dev !== current.dev || opened.ino !== current.ino ||
            !opened.isFile() || !current.isFile() ||
            (await fsp.realpath(p)) !== p) {
            return null;
        }
        const fdPath = await openedHandlePath(handle);
        if (fdPath !== null && fdPath !== p) {
            return null;
        }
        // Bounded read: a file that grows after stat() would make readFile()
        // load the whole new contents before any length check, so loop the
        // transfer up to MAX_IMAGE_BYTES + 1 and reject anything that
        // overflows; the loop also rules out a short read truncating the image.
        const payload = await readBounded(handle, MAX_IMAGE_BYTES);
        if (payload.length > MAX_IMAGE_BYTES) {
            return null;
        }
        if ((await fsp.realpath(p)) !== p) {
            return null;
        }
        return payload;
    } catch {
        return null;
    } finally {
        await handle.close();
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
 *     leaf swap cannot redirect the read outside the workspace. The open
 *     also carries O_NONBLOCK: a FIFO's blocking O_RDONLY open would park
 *     the send until a writer attaches, before the regular-file check can
 *     reject it.
 *  3. Compare the opened handle's identity (dev/ino) against a fresh lstat
 *     of the path. This covers Windows too, where O_NOFOLLOW is unavailable:
 *     a symlink/junction swapped in at the final component yields a mismatch
 *     instead of foreign content.
 *  4. Verify the opened handle's own location via the fd link (/proc/self/fd
 *     on Linux, /dev/fd on other POSIX systems): the fd link always resolves through the current directory
 *     chain to the actual opened inode, so an intermediate-directory swap
 *     that happened before open is exposed even if the attacker reverts
 *     the directory before the later checks — the pre-open realpath and
 *     the identity comparison both read live path state, but the fd link
 *     is anchored to the opened handle.
 *  5. Re-canonicalize the path after the read and discard on any drift.
 *  On Windows the fd link is unavailable, so the swap-revert window there
 *  relies on the dev/ino comparison alone.
 */
export async function readAttachments(
    attachments: Attachment[],
    options?: { imageMode?: 'inline' | 'tempFile'; reservedPromptBytes?: number }
): Promise<{ prompt: string; dispose: () => Promise<void> }> {
    const imageMode = options?.imageMode ?? 'inline';
    const totalBudget = Math.max(
        0,
        ATTACHMENT_TOTAL_MAX_BYTES - (options?.reservedPromptBytes ?? 0)
    );
    const sections: string[] = [];
    let totalEncodedBytes = 0;

    // Directory holding snapshot copies of image bytes for transports that
    // cannot carry inline base64 in the prompt (see the image branch below).
    // Created lazily on the first image so text-only sends never touch the
    // filesystem outside the workspace.
    let snapshotDir: string | null = null;

    for (const att of attachments) {
        // Image paths are handed to a downstream reader, so the same
        // re-canonicalization as text attachments applies before emitting: a
        // path swapped for a symlink after mention validation is dropped.
        if (att.type === 'image') {
            // The image content is read here, through the verified handle, and
            // emitted from bytes: handing a path to the downstream reader would
            // reopen a TOCTOU window between this validation and that open, so
            // the final open/read happens on the trusted side instead.
            const bytes = await readVerifiedImageBytes(att.path);
            if (bytes === null) {
                sections.push('[Could not read file]');
                continue;
            }
            // The aggregate budget is the encoded payload size actually sent
            // over the wire: inline images travel as a base64 data URI (~4/3
            // of the raw bytes), while temp-file images contribute only their
            // raw bytes (the payload carries the snapshot path, not the
            // content). Counting raw bytes for inline images would let two
            // allowed 10 MiB images pass a 20 MiB check while contributing
            // ~26.7 MiB of base64, exceeding the transport payload cap.
            // Counting the encoded payload size actually sent: base64 with
            // padding is ceil(n/3)*4 — for lengths not divisible by 3 this
            // exceeds the ~4/3 estimate, so the padded length is counted.
            const encodedBytes =
                imageMode === 'inline' ? Math.ceil(bytes.length / 3) * 4 : bytes.length;
            if (totalEncodedBytes + encodedBytes > totalBudget) {
                sections.push(frameFileBody(att.path, '[Attachment skipped: aggregate attachment size limit reached]'));
                continue;
            }
            if (imageMode === 'inline') {
                // Gateway transports receive the prompt over an RPC payload, so
                // the bytes travel inline as a data URI and the gateway reads
                // the image without filesystem access to this machine.
                totalEncodedBytes += encodedBytes;
                sections.push(`<image data="data:${imageMimeByPath(att.path)};base64,${bytes.toString('base64')}" />`);
            } else {
                // CLI transports (acpx) receive the prompt as a single spawn()
                // argv element, capped far below the encoded sizes allowed here
                // by POSIX execve per-argument limits — a multi-megabyte inline
                // image fails with E2BIG instead of attaching. Snapshot the
                // verified bytes into a private temp file (0600, unique dir) and
                // hand the CLI its path: the copy is taken through the verified
                // handle, so no attacker-controlled path is reopened downstream,
                // and the snapshot's content is exactly what was validated.
                if (snapshotDir === null) {
                    try {
                        snapshotDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-attach-'));
                    } catch {
                        sections.push('[Could not read file]');
                        continue;
                    }
                }
                const safeName = att.name.replace(/[^A-Za-z0-9._-]/g, '_');
                const snapshotPath = path.join(snapshotDir, `${randomUUID()}-${safeName}`);
                try {
                    await fsp.writeFile(snapshotPath, bytes, { mode: 0o600 });
                } catch {
                    sections.push('[Could not read file]');
                    continue;
                }
                totalEncodedBytes += encodedBytes;
                sections.push(`<image path="${escapeXmlAttr(snapshotPath)}" />`);
            }
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
            const handle = await fsp.open(real, fsConstants.O_RDONLY | noFollow | openNonBlock);
            try {
                const opened = await handle.stat();
                const current = await fsp.lstat(real);
                // A FIFO or other special file passes the O_NOFOLLOW open:
                // O_NONBLOCK keeps the open itself from parking on a FIFO
                // until a writer attaches, and the regular-file check below
                // rejects the special file instead (readFile() on a FIFO
                // would block indefinitely and hang the send — the same gate
                // as image verification above).
                if (!opened.isFile() || !current.isFile()) {
                    throw new Error('attachment path is not a regular file');
                }
                if (opened.dev !== current.dev || opened.ino !== current.ino) {
                    throw new Error('attachment path changed during read');
                }
                const fdPath = await openedHandlePath(handle);
                if (fdPath !== null && fdPath !== real) {
                    throw new Error('attachment opened outside its canonical path');
                }
                // Same bounded-read gate as image verification: loop the
                // transfer so a file that grows after stat() cannot blow up
                // memory before the size check, and a short read cannot
                // truncate the attachment.
                const textLimit =
                    imageMode === 'tempFile' ? ATTACHMENT_TEXT_ARG_MAX_BYTES : ATTACHMENT_TEXT_MAX_BYTES;
                const bytes = await readBounded(handle, textLimit);
                if (bytes.length > textLimit) {
                    throw new Error('attachment file exceeds the size limit');
                }
                const content = new TextDecoder().decode(bytes);
                // Budget counts the UTF-8 bytes the prompt will carry, not
                // the raw file length: TextDecoder maps invalid bytes to
                // U+FFFD (three UTF-8 bytes), so a non-UTF-8 attachment can
                // expand past the cap after this check otherwise. The budget
                // is only charged after the final realpath validation below
                // succeeds — a swapped/disappeared file must not consume the
                // aggregate budget and silently crowd out later attachments.
                const encodedBytes = Buffer.byteLength(content, 'utf8');
                if (totalEncodedBytes + encodedBytes > totalBudget) {
                    sections.push(frameFileBody(att.path, '[Attachment skipped: aggregate attachment size limit reached]'));
                    continue;
                }
                const realAfter = await fsp.realpath(real);
                if (realAfter !== real) {
                    throw new Error('attachment path changed during read');
                }
                totalEncodedBytes += encodedBytes;
                sections.push(frameFileBody(att.path, sliceLineRange(content, att.lineStart, att.lineEnd)));
            } finally {
                await handle.close();
            }
        } catch {
            sections.push(frameFileBody(att.path, '[Could not read file]'));
        }
    }

    // Temp-file mode snapshots validated image bytes into a private temp
    // directory consumed by the CLI (acpx) process. The caller ties `dispose`
    // to the process completion/error path (after the child has consumed the
    // paths, including cancellation and spawn failure) so repeated image
    // attachments cannot accumulate validated bytes and exhaust temp disk.
    // Inline mode never creates the directory, so dispose is a no-op.
    const dispose = async (): Promise<void> => {
        if (snapshotDir !== null) {
            const dir = snapshotDir;
            snapshotDir = null;
            await fsp.rm(dir, { recursive: true, force: true });
        }
    };
    return { prompt: sections.join('\n\n'), dispose };
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