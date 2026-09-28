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

function frameFileBody(filePath: string, content: string): string {
    return frameTaggedBlock('file', { path: filePath }, content);
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

/** Aggregate argv budget for CLI transports (`imageMode: 'tempFile'`): the
 *  whole prompt travels as ONE execve argument (`args.push('exec', prompt)`),
 *  so Linux's per-argument limit (MAX_ARG_STRLEN, ~128 KiB) bounds the
 *  attachments plus the base prompt together — not each file alone. Two
 *  allowed 64 KiB text attachments, or one attachment plus a large base
 *  prompt, would still fail the spawn with E2BIG under per-file caps alone.
 *  The 32 KiB headroom below the kernel limit covers the CLI prefix,
 *  configured system prompt, and argument framing; callers subtract the
 *  base prompt's bytes via `reservedArgvBytes` so attachments and prompt
 *  jointly stay inside the limit. */
const ATTACHMENT_ARGV_TOTAL_MAX_BYTES = 96 * 1024;

/** Aggregate cap on the raw validated image bytes materialized as temp-file
 *  snapshots for CLI transports (`imageMode: 'tempFile'`). Temp-file images are
 *  deliberately excluded from the argv budget (their bytes travel on disk, not
 *  in the prompt), so without this cap a user could attach many 10 MiB images
 *  and accumulate multi-gigabyte snapshot copies in the temp directory before
 *  the spawn. The cap keeps the materialized bytes in line with the inline
 *  transport's aggregate payload budget, so the two transports bound the same
 *  total. */
const ATTACHMENT_SNAPSHOT_TOTAL_MAX_BYTES = 20 * 1024 * 1024;

/** Slack subtracted with the reserved prompt bytes so RPC framing, message
 *  history, and per-section decoration around the attachments also fit
 *  under the transport's payload cap. */
export const ATTACHMENT_PROMPT_FRAMING_RESERVE_BYTES = 1024 * 1024;

/** Small framing slack for the CLI argv budget (attachment framing plus the
 *  acpx argument prefix around the prompt). */
export const ATTACHMENT_ARGV_FRAMING_RESERVE_BYTES = 4 * 1024;

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
        if (!(await handleIsAtPath(handle, p))) {
            return null;
        }
        // Bounded read: a file that grows after stat() would make readFile()
        // load the whole new contents before any length check, so loop the
        // transfer up to MAX_IMAGE_BYTES + 1 and reject anything that
        // overflows; the loop also rules out a short read truncating the image.
        const payload = await readBounded(handle, MAX_IMAGE_BYTES, opened.size);
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

/** Read a text attachment through a verified handle (steps 1-4 of the
 *  hardening described on {@link readAttachments}). Throws on any failed
 *  check, and AttachmentTooLargeError when the file exceeds `maxBytes`. */
async function readVerifiedTextBytes(p: string, maxBytes: number): Promise<Buffer> {
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
        /** Bytes of the final prompt (base prompt, not attachments) already
         *  known to the caller — subtracted from the CLI argv budget so
         *  attachments plus prompt jointly stay inside MAX_ARG_STRLEN. */
        reservedArgvBytes?: number;
    }
): Promise<{ prompt: string; dispose: () => Promise<void> }> {
    const imageMode = options?.imageMode ?? 'inline';
    // Inline mode sends the prompt as an RPC payload (base64 images + text
    // count against ATTACHMENT_TOTAL); temp-file mode travels as a single
    // execve argv element, where images charge only their path framing since
    // their bytes live on disk.
    const transportBudget = imageMode === 'tempFile'
        ? Math.max(0, ATTACHMENT_ARGV_TOTAL_MAX_BYTES - (options?.reservedArgvBytes ?? 0))
        : Math.max(0, ATTACHMENT_TOTAL_MAX_BYTES - (options?.reservedPromptBytes ?? 0));
    const textLimit = imageMode === 'tempFile' ? ATTACHMENT_TEXT_ARG_MAX_BYTES : ATTACHMENT_TEXT_MAX_BYTES;
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

    const emitNote = (message: string) => {
        if (!emitIfFits(message)) {
            attachmentsDropped = true;
        }
    };

    // Created lazily on the first temp-file image so text-only sends never
    // touch the filesystem outside the workspace.
    let snapshotDir: string | null = null;
    // Raw bytes already snapshotted, bounded separately from the argv budget.
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

    const emitImage = async (att: Attachment) => {
        // Read through the verified handle and emitted from bytes: handing the
        // path downstream would reopen a TOCTOU window at the reader's open.
        const bytes = await readVerifiedImageBytes(att.path);
        if (bytes === null) {
            emitNote(UNREADABLE_MARKER);
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
        // CLI transports cannot carry megabytes of base64 in one argv element,
        // so the verified bytes are snapshotted into a private temp file (0600,
        // unique dir) and the CLI gets its path.
        if (!fitsTransport(1) || snapshotBytes + bytes.length > ATTACHMENT_SNAPSHOT_TOTAL_MAX_BYTES) {
            emitRejection(att.path, AGGREGATE_LIMIT_MARKER);
            return;
        }
        const snapshotPath = await writeSnapshot(att.name, bytes);
        if (snapshotPath === null) {
            emitNote(UNREADABLE_MARKER);
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
            // A ranged mention is capped after slicing, so the raw read only
            // needs the memory bound of the inline cap.
            const readLimit = att.lineStart != null ? ATTACHMENT_TEXT_MAX_BYTES : textLimit;
            const bytes = await readVerifiedTextBytes(att.path, readLimit);
            // NUL cannot travel in an execve argument and marks binary content.
            if (bytes.includes(0)) {
                emitRejection(att.path, BINARY_FILE_MARKER);
                return;
            }
            const text = sliceLineRange(new TextDecoder().decode(bytes), att.lineStart, att.lineEnd);
            // Counted after decoding: invalid bytes expand to U+FFFD (3 bytes).
            if (Buffer.byteLength(text, 'utf8') > textLimit) {
                throw new AttachmentTooLargeError();
            }
            if ((await fsp.realpath(att.path)) !== att.path) {
                throw new Error('attachment path changed during read');
            }
            if (!emitIfFits(frameFileBody(att.path, text))) {
                emitRejection(att.path, AGGREGATE_LIMIT_MARKER);
            }
        } catch (err) {
            emitRejection(att.path, err instanceof AttachmentTooLargeError ? FILE_SIZE_LIMIT_MARKER : UNREADABLE_MARKER);
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