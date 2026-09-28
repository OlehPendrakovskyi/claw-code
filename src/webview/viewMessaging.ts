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
import { ChatService, PROMPT_MAX_BYTES, UsageInfo } from '../chat/ChatService';
import type { GatewayChatService } from '../core/gatewayChatService';
import { EditorContext, ContextType, escapeXmlAttr, frameTaggedBlock } from './slashCommands';
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

/** Link schemes a rendered reply may keep; anything else could run script
 *  or reach the editor's own URI handlers when clicked. */
const SAFE_LINK_SCHEME = /^(?:https?|mailto):/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the entities the markdown renderer writes into an attribute, once,
 *  as the browser does before it resolves the URL. */
function decodeAttributeValue(value: string): string {
    // Numeric references decode even without their semicolon.
    return value.replace(/&(?:#(\d+);?|#x([0-9a-f]+);?|(amp|lt|gt|quot|apos);)/gi, (entity, dec, hex, named) => {
        if (named !== undefined) {
            return NAMED_ENTITIES[named.toLowerCase()];
        }
        const codePoint = dec !== undefined ? Number(dec) : parseInt(hex, 16);
        return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : entity;
    });
}

/** `value` without the leading C0 controls and spaces a URL parser skips. */
function stripLeadingControls(value: string): string {
    let start = 0;
    while (start < value.length && value.charCodeAt(start) <= 0x20) {
        start += 1;
    }
    return value.slice(start);
}

/** Whether a link target keeps its href: relative, or an allowed scheme. */
function isSafeHref(rawValue: string): boolean {
    // Browsers also drop ASCII tab and newline anywhere in a URL.
    const href = stripLeadingControls(decodeAttributeValue(rawValue).replace(/[\t\n\r]/g, ''));
    return !URL_SCHEME.test(href) || SAFE_LINK_SCHEME.test(href);
}

/** The renderer escapes raw HTML but keeps any link scheme, so unsafe hrefs are neutralized here. */
function neutralizeUnsafeLinks(html: string): string {
    return html.replace(/(<a\b[^>]*?\shref=")([^"]*)(")/gi, (match, before, value, after) =>
        isSafeHref(value) ? match : `${before}#${after}`
    );
}

/** Convert markdown text to sanitized HTML for the webview. */
export async function renderMarkdown(text: string): Promise<string> {
    try {
        return neutralizeUnsafeLinks(await markdownToHTML(text, { sanitize: true }));
    } catch (err) {
        log.warn('markdownToHTML failed, using fallback', err);
        return escapeHtml(text);
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function frameFileBody(filePath: string, content: string): string {
    return frameTaggedBlock('file', { path: filePath }, content);
}

/** Whether an opened handle still refers to the file at canonical path
 *  `expected`, judged by the OS's handle view rather than live path state.
 *
 *  The fd link is anchored to the opened inode, so a parent directory
 *  swapped before open and restored afterwards still shows the swap, which
 *  the path-based checks around it cannot see.
 *  - Linux always provides /proc/self/fd, so a lookup that fails or points
 *    elsewhere (including a deleted file's " (deleted)" suffix) rejects.
 *  - Other POSIX systems offer /dev/fd at best; macOS and FreeBSD without
 *    `linrdlnk` echo the fd path back, which carries no location. Only a
 *    resolution to a different path rejects there, so attachments keep
 *    working and those systems rely on the identity checks, as Windows does.
 *  - Windows has no fd view. */
async function handleIsAtPath(handle: fsp.FileHandle, expected: string): Promise<boolean> {
    if (process.platform === 'win32') {
        return true;
    }
    if (process.platform === 'linux') {
        try {
            return (await fsp.realpath(`/proc/self/fd/${handle.fd}`)) === expected;
        } catch {
            return false;
        }
    }
    const fdPath = `/dev/fd/${handle.fd}`;
    try {
        const resolved = await fsp.realpath(fdPath);
        return resolved === fdPath || resolved === expected;
    } catch {
        return true;
    }
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

/** Cap for image attachments: a large image would otherwise be
 *  base64-expanded in memory with no limit and overflow the Gateway's
 *  maximum payload. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Cap for text attachment reads: bounds the transfer itself so a file that
 *  grows after stat() cannot be loaded in full before any size check. */
const ATTACHMENT_TEXT_MAX_BYTES = 10 * 1024 * 1024;

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
 *  and the send fails despite passing every check here. acpx caps its whole
 *  prompt at the same size. */
const ATTACHMENT_TOTAL_MAX_BYTES = PROMPT_MAX_BYTES;

/** Aggregate cap on the raw validated image bytes materialized as temp-file
 *  snapshots for CLI transports (`imageMode: 'tempFile'`). Temp-file images
 *  charge only their path framing to the payload budget (their bytes travel
 *  on disk, not in the prompt), so without this cap a user could attach many
 *  10 MiB images and accumulate multi-gigabyte snapshot copies in the temp
 *  directory before the spawn. The cap keeps the materialized bytes in line with the inline
 *  transport's aggregate payload budget, so the two transports bound the same
 *  total. */
const ATTACHMENT_SNAPSHOT_TOTAL_MAX_BYTES = 20 * 1024 * 1024;

/** Slack subtracted with the reserved prompt bytes so RPC framing, message
 *  history, and per-section decoration around the attachments also fit
 *  under the transport's payload cap. */
export const ATTACHMENT_PROMPT_FRAMING_RESERVE_BYTES = 1024 * 1024;

/** Size of each read after the stat-sized first one: those reads only prove
 *  EOF or catch growth since stat(), so they stay small. */
const READ_FOLLOW_UP_CHUNK_BYTES = 64 * 1024;

/** Read from an opened handle until EOF or the byte budget is exhausted.
 *
 *  A single FileHandle.read() is not guaranteed to fill the requested buffer:
 *  regular files can return a short read before EOF, so a one-shot read can
 *  accept a truncated file or let a file that grew past the cap slip through
 *  (the short result lands under the limit). Loop until EOF or maxBytes + 1
 *  bytes are collected, so callers can reject anything above maxBytes and
 *  otherwise get the byte-faithful contents. The first chunk is sized from
 *  `statSize` so a small file never allocates the whole cap. */
async function readBounded(handle: fsp.FileHandle, maxBytes: number, statSize: number): Promise<Buffer> {
    const limit = maxBytes + 1;
    const chunks: Buffer[] = [];
    let total = 0;
    let chunkSize = Math.min(limit, statSize + 1);
    while (total < limit) {
        const chunk = Buffer.allocUnsafe(Math.min(chunkSize, limit - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
        if (bytesRead === 0) {
            break;
        }
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
        chunkSize = READ_FOLLOW_UP_CHUNK_BYTES;
    }
    return Buffer.concat(chunks, total);
}

const UNREADABLE_MARKER = '[Could not read file]';
const AGGREGATE_LIMIT_MARKER = '[Attachment skipped: aggregate attachment size limit reached]';
const FILE_SIZE_LIMIT_MARKER = '[Attachment skipped: file exceeds size limit]';
const BINARY_FILE_MARKER = '[Binary file skipped]';
const ATTACHMENTS_DROPPED_NOTE = '[Some attachments were skipped: attachment size limit reached]';

const SECTION_SEPARATOR = '\n\n';

/** Longest snapshot file name: NAME_MAX is 255 bytes, minus the UUID prefix. */
const SNAPSHOT_NAME_MAX_BYTES = 255 - 37;
const SNAPSHOT_EXTENSION_MAX_BYTES = 16;

class AttachmentTooLargeError extends Error {}

/** Snapshot file name for an image: `<uuid>-<name>`, ASCII-only and within
 *  NAME_MAX, keeping a short extension so the reader can sniff the type. */
function snapshotFileName(name: string): string {
    const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_');
    const extension = path.extname(safeName);
    const keptExtension = extension.length <= SNAPSHOT_EXTENSION_MAX_BYTES ? extension : '';
    const stem = safeName
        .slice(0, safeName.length - keptExtension.length)
        .slice(0, SNAPSHOT_NAME_MAX_BYTES - keptExtension.length);
    return `${randomUUID()}-${stem}${keptExtension}`;
}

/** Read an attachment through a verified handle (steps 1-5 of the hardening
 *  described on {@link readAttachments}), so the bytes returned are exactly
 *  those of the validated file. Throws on any failed check, and
 *  AttachmentTooLargeError when the file exceeds `maxBytes`. */
async function readVerifiedBytes(p: string, maxBytes: number): Promise<Buffer> {
    // Exact match: even a case-only difference can be another file on a case-sensitive volume.
    if ((await fsp.realpath(p)) !== p) {
        throw new Error('attachment path no longer canonical');
    }
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    const handle = await fsp.open(p, fsConstants.O_RDONLY | noFollow | openNonBlock);
    try {
        const opened = await handle.stat();
        const current = await fsp.lstat(p);
        // O_NONBLOCK lets a FIFO or other special file pass the open; reject
        // it here, since reading a FIFO would block the send indefinitely.
        if (!opened.isFile() || !current.isFile()) {
            throw new Error('attachment path is not a regular file');
        }
        if (opened.dev !== current.dev || opened.ino !== current.ino) {
            throw new Error('attachment path changed during read');
        }
        if (!(await handleIsAtPath(handle, p))) {
            throw new Error('attachment opened outside its canonical path');
        }
        if (opened.size > maxBytes) {
            throw new AttachmentTooLargeError();
        }
        const bytes = await readBounded(handle, maxBytes, opened.size);
        if (bytes.length > maxBytes) {
            throw new AttachmentTooLargeError();
        }
        if ((await fsp.realpath(p)) !== p) {
            throw new Error('attachment path changed during read');
        }
        return bytes;
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
 *  4. Verify the opened handle's own location via the fd link
 *     ({@link handleIsAtPath}): it is anchored to the opened inode, so an
 *     intermediate-directory swap that happened before open is exposed even
 *     if the attacker reverts the directory before the later checks — the
 *     pre-open realpath and the identity comparison both read live path
 *     state.
 *  5. Re-canonicalize the path after the read and discard on any drift.
 *  Where the OS offers no resolvable fd link (Windows, macOS), the
 *  swap-revert window relies on the dev/ino comparison and the
 *  re-canonicalizations alone.
 */
export async function readAttachments(
    attachments: Attachment[],
    options?: {
        imageMode?: 'inline' | 'tempFile';
        reservedPromptBytes?: number;
    }
): Promise<{ prompt: string; dispose: () => Promise<void> }> {
    const imageMode = options?.imageMode ?? 'inline';
    // Inline images charge their base64 to the budget; temp-file images only
    // their path framing, since their bytes live on disk.
    const transportBudget = Math.max(0, ATTACHMENT_TOTAL_MAX_BYTES - (options?.reservedPromptBytes ?? 0));
    let transportBytes = 0;
    const sections: string[] = [];
    let attachmentsDropped = false;

    const fitsTransport = (bytes: number) => transportBytes + bytes <= transportBudget;

    /** Push a section charged with its separator, or report that it did not fit. */
    const emitIfFits = (section: string): boolean => {
        const cost = Buffer.byteLength(section, 'utf8') + SECTION_SEPARATOR.length;
        if (!fitsTransport(cost)) {
            return false;
        }
        transportBytes += cost;
        sections.push(section);
        return true;
    };

    // Rejection markers are charged too: many rejected attachments could
    // otherwise collectively exceed the transport budget. Past the framed
    // marker the bare message is tried, then the rejection is dropped.
    const emitRejection = (filePath: string, message: string) => {
        if (!emitIfFits(frameFileBody(filePath, message)) && !emitIfFits(message)) {
            attachmentsDropped = true;
        }
    };

    // Created lazily on the first temp-file image so text-only sends never
    // touch the filesystem outside the workspace.
    let snapshotDir: string | null = null;
    // Raw bytes already snapshotted, bounded separately from the payload budget.
    let snapshotBytes = 0;

    const writeSnapshot = async (name: string, bytes: Buffer): Promise<string | null> => {
        try {
            if (snapshotDir === null) {
                snapshotDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-attach-'));
            }
            const snapshotPath = path.join(snapshotDir, snapshotFileName(name));
            await fsp.writeFile(snapshotPath, bytes, { mode: 0o600 });
            return snapshotPath;
        } catch {
            return null;
        }
    };

    // The caller ties `dispose` to process completion (including cancellation
    // and spawn failure) so repeated sends cannot accumulate snapshot bytes. A
    // failed removal keeps the directory so a later dispose can retry.
    const dispose = async (): Promise<void> => {
        if (snapshotDir === null) {
            return;
        }
        try {
            await fsp.rm(snapshotDir, { recursive: true, force: true });
            snapshotDir = null;
        } catch (err) {
            log.warn(`Failed to remove attachment snapshots at ${snapshotDir}`, err);
        }
    };

    const rejectionMarker = (err: unknown) => err instanceof AttachmentTooLargeError ? FILE_SIZE_LIMIT_MARKER : UNREADABLE_MARKER;

    const emitImage = async (att: Attachment) => {
        // Read through the verified handle and emitted from bytes: handing the
        // path downstream would reopen a TOCTOU window at the reader's open.
        let bytes: Buffer;
        try {
            bytes = await readVerifiedBytes(att.path, MAX_IMAGE_BYTES);
        } catch (err) {
            emitRejection(att.path, rejectionMarker(err));
            return;
        }
        if (imageMode === 'inline') {
            // Padded base64 length, checked before the string is built.
            const encodedBytes = Math.ceil(bytes.length / 3) * 4;
            const section = fitsTransport(encodedBytes)
                ? `<image data="data:${imageMimeByPath(att.path)};base64,${bytes.toString('base64')}" />`
                : null;
            if (section === null || !emitIfFits(section)) {
                emitRejection(att.path, AGGREGATE_LIMIT_MARKER);
            }
            return;
        }
        // The CLI agent reads images from disk, so the verified bytes are snapshotted
        // into a private temp file (0600, unique dir) and the CLI gets its path.
        if (!fitsTransport(1) || snapshotBytes + bytes.length > ATTACHMENT_SNAPSHOT_TOTAL_MAX_BYTES) {
            emitRejection(att.path, AGGREGATE_LIMIT_MARKER);
            return;
        }
        const snapshotPath = await writeSnapshot(att.name, bytes);
        if (snapshotPath === null) {
            emitRejection(att.path, UNREADABLE_MARKER);
            return;
        }
        if (!emitIfFits(`<image path="${escapeXmlAttr(snapshotPath)}" />`)) {
            await fsp.rm(snapshotPath, { force: true });
            emitRejection(att.path, AGGREGATE_LIMIT_MARKER);
            return;
        }
        snapshotBytes += bytes.length;
    };

    const emitText = async (att: Attachment) => {
        try {
            const bytes = await readVerifiedBytes(att.path, ATTACHMENT_TEXT_MAX_BYTES);
            // NUL marks binary content.
            if (bytes.includes(0)) {
                emitRejection(att.path, BINARY_FILE_MARKER);
                return;
            }
            const text = sliceLineRange(new TextDecoder().decode(bytes), att.lineStart, att.lineEnd);
            // Counted after decoding: invalid bytes expand to U+FFFD (3 bytes).
            if (Buffer.byteLength(text, 'utf8') > ATTACHMENT_TEXT_MAX_BYTES) {
                throw new AttachmentTooLargeError();
            }
            if (!emitIfFits(frameFileBody(att.path, text))) {
                emitRejection(att.path, AGGREGATE_LIMIT_MARKER);
            }
        } catch (err) {
            emitRejection(att.path, rejectionMarker(err));
        }
    };

    try {
        for (const att of attachments) {
            await (att.type === 'image' ? emitImage(att) : emitText(att));
        }
    } catch (err) {
        await dispose();
        throw err;
    }
    // Never drop attachments silently; this one note rides on the framing reserve.
    if (attachmentsDropped) {
        sections.push(ATTACHMENTS_DROPPED_NOTE);
    }
    return { prompt: sections.join(SECTION_SEPARATOR), dispose };
}

/** Slice a file body to a 1-based inclusive line range when the mention carries a #L range.
 *  A missing range returns the whole body; a non-positive start clamps to line 1;
 *  reversed ranges (end < start) collapse to the start line; CRLF is handled by
 *  splitting on `/\r?\n/` so Windows line endings do not pollute slices; a
 *  start past the last line yields an explicit marker instead of an empty body. */
export function sliceLineRange(content: string, lineStart?: number, lineEnd?: number): string {
    if (lineStart == null) {
        return content;
    }
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, lineStart) - 1;
    const requestedEnd = Math.max(lineStart, lineEnd ?? lineStart);
    const totalLines = lineCount(lines);
    if (start >= totalLines) {
        return `[Lines ${lineStart}-${requestedEnd} are beyond the end of the file (${totalLines} lines)]`;
    }
    return lines.slice(start, Math.min(lines.length, Math.max(1, requestedEnd))).join('\n');
}

/** Lines in a split body, not counting the empty piece after a final newline. */
function lineCount(lines: string[]): number {
    return lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
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

type FileSearchResult = { name: string; path: string; relativePath: string };

const FILE_SEARCH_RESULT_LIMIT = 15;
const FILE_SEARCH_EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}';
/** Files the name-glob pass asks for before falling back to a full scan. */
const FILE_SEARCH_GLOB_MAX_RESULTS = 30;
/** Bounds the fallback scan so a keystroke never enumerates a huge workspace. */
const FILE_SEARCH_SCAN_MAX_RESULTS = 5000;
/** No file name is longer, so a longer query cannot match a name glob. */
const FILE_NAME_MAX_CHARS = 255;
/** Glob syntax (and its escape) differs between VS Code's matcher and
 *  ripgrep, so a query using any of it only goes through the literal scan. */
const GLOB_SYNTAX = /[[\]{}()*?!\\,]/;

function toFileSearchResult(uri: vscode.Uri, cwd: string): FileSearchResult {
    return {
        name: path.basename(uri.fsPath),
        path: uri.fsPath,
        relativePath: cwd ? path.relative(cwd, uri.fsPath) : uri.fsPath,
    };
}

function openEditorFiles(cwd: string): FileSearchResult[] {
    const files: FileSearchResult[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText) {
                files.push(toFileSearchResult(tab.input.uri, cwd));
            }
        }
    }
    return files;
}

/** Rank for sorting: name prefix, name substring, path prefix, anything else. */
function fileMatchRank(file: FileSearchResult, lowerQuery: string): number {
    const lowerName = file.name.toLowerCase();
    if (lowerName.startsWith(lowerQuery)) {
        return 0;
    }
    if (lowerName.includes(lowerQuery)) {
        return 1;
    }
    return file.relativePath.toLowerCase().startsWith(lowerQuery) ? 2 : 3;
}

async function findWorkspaceFiles(pattern: string, maxResults: number): Promise<vscode.Uri[]> {
    try {
        return await vscode.workspace.findFiles(pattern, FILE_SEARCH_EXCLUDE, maxResults);
    } catch (err) {
        log.warn(`file search for ${pattern} failed`, err);
        return [];
    }
}

async function searchWorkspaceFiles(trimmedQuery: string, cwd: string): Promise<FileSearchResult[]> {
    const lowerQuery = trimmedQuery.toLowerCase();
    const matches = new Map<string, FileSearchResult>();
    const collect = (uris: vscode.Uri[]) => {
        for (const file of uris.map(uri => toFileSearchResult(uri, cwd))) {
            const matchesQuery = file.name.toLowerCase().includes(lowerQuery) || file.relativePath.toLowerCase().includes(lowerQuery);
            if (matchesQuery && !matches.has(file.path)) {
                matches.set(file.path, file);
            }
        }
    };
    if (!lowerQuery) {
        collect(await findWorkspaceFiles('**/*', FILE_SEARCH_GLOB_MAX_RESULTS));
        return [...matches.values()].sort((a, b) => a.relativePath.length - b.relativePath.length);
    }
    if (!GLOB_SYNTAX.test(trimmedQuery) && trimmedQuery.length <= FILE_NAME_MAX_CHARS) {
        collect(await findWorkspaceFiles(`**/*${trimmedQuery}*`, FILE_SEARCH_GLOB_MAX_RESULTS));
    }
    // The glob is case-sensitive and sees only names, so directory and case-insensitive hits need the scan.
    if (matches.size < FILE_SEARCH_RESULT_LIMIT) {
        collect(await findWorkspaceFiles('**/*', FILE_SEARCH_SCAN_MAX_RESULTS));
    }
    return [...matches.values()].sort((a, b) =>
        fileMatchRank(a, lowerQuery) - fileMatchRank(b, lowerQuery) || a.relativePath.length - b.relativePath.length
    );
}

/** Answer a webview file-search request: open editors for an empty query, else workspace files. */
/** `replyFields` ride along on the reply, e.g. to tie it to the request. */
export async function handleFileSearch(
    query: string,
    webview: vscode.Webview,
    cwd: string,
    replyFields: Record<string, unknown> = {}
): Promise<void> {
    if (!query) {
        const openFiles = openEditorFiles(cwd);
        if (openFiles.length > 0) {
            webview.postMessage({ type: 'fileSearchResults', ...replyFields, files: openFiles.slice(0, FILE_SEARCH_RESULT_LIMIT) });
            return;
        }
    }
    const files = await searchWorkspaceFiles(query.trim(), cwd);
    webview.postMessage({ type: 'fileSearchResults', ...replyFields, files: files.slice(0, FILE_SEARCH_RESULT_LIMIT) });
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