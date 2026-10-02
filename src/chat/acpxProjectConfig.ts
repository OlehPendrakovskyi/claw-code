import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { readBoundedSync } from '../core/readBounded';

/** The one project-level file acpx 0.19.3 reads, from its `--cwd` (no parent
 *  walk, no opt-out flag): it can redefine agent commands and MCP servers.
 *  acpx reopens it by path after our check, and that same `--cwd` is the agent's
 *  workspace, so it cannot be pointed at a private copy. The gap lets only a
 *  process already writing in the workspace swap the file, milliseconds before a
 *  send; one running as the user could run any command anyway. */
const PROJECT_CONFIG_NAME = '.acpxrc.json';

const APPROVALS_KEY = 'openclaw.acpx.approvedProjectConfigs';
const APPROVALS_MAX = 200;
const PREVIEW_MAX_CHARS = 2000;
/** Larger than any real config; a bigger file is refused rather than read. */
const CONFIG_MAX_BYTES = 256 * 1024;
const ALLOW_ACTION = 'Allow and Run';
const REVIEW_ACTION = 'Open File to Review';
const DIRTY_REVIEW_MESSAGE = 'The acpx config has unsaved changes in the editor, so what you reviewed is not what acpx would read. Save or revert it, then send again.';
const APPROVAL_QUESTION = 'This workspace has an acpx config that can change which commands acpx runs for agents and MCP servers. Run acpx with it?';

/** A FIFO opens without waiting for a writer; the regular-file check then refuses it. */
const OPEN_NON_BLOCKING = process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK;

/** Where approvals persist: the extension's globalState once configured, else this session only. */
export type ApprovalStore = {
    get(key: string): unknown;
    update(key: string, value: unknown): Thenable<void>;
};

export type ProjectConfigCheck =
    | { status: 'trusted' }
    | { status: 'unreadable'; configPath: string }
    | { status: 'unapproved'; configPath: string; approvalKey: string; text: string };

const sessionApprovals = new Map<string, unknown>();
let approvalStore: ApprovalStore = {
    get: key => sessionApprovals.get(key),
    update: async (key, value) => {
        sessionApprovals.set(key, value);
    },
};

/** Persists approvals in `store` (the extension's globalState) from now on. */
export function useProjectConfigApprovalStore(store: ApprovalStore): void {
    approvalStore = store;
}

/** Whether acpx may start in `cwd`: no project config, or one approved byte for byte.
 *  Synchronous but never blocking: a non-blocking open and a bounded read of a regular file. */
export function checkProjectConfig(cwd: string): ProjectConfigCheck {
    const configPath = path.join(path.resolve(cwd), PROJECT_CONFIG_NAME);
    let bytes: Buffer | undefined;
    try {
        bytes = readBoundedRegularFile(configPath);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { status: 'trusted' };
        }
    }
    if (bytes === undefined) {
        return { status: 'unreadable', configPath };
    }
    const approvalKey = approvalKeyFor(cwd, bytes);
    if (approvedKeys().includes(approvalKey)) {
        return { status: 'trusted' };
    }
    return { status: 'unapproved', configPath, approvalKey, text: bytes.toString('utf8') };
}

/** Asks the user, in a modal, to trust this exact config; remembers a yes. A
 *  config too long to preview is approved only after it was opened in full. */
export async function requestProjectConfigApproval(check: Extract<ProjectConfigCheck, { status: 'unapproved' }>): Promise<boolean> {
    const approved = check.text.length > PREVIEW_MAX_CHARS ? await approveAfterReview(check) : await approveFromPreview(check);
    if (!approved) {
        return false;
    }
    const kept = approvedKeys().filter(key => key !== check.approvalKey).slice(-(APPROVALS_MAX - 1));
    await approvalStore.update(APPROVALS_KEY, [...kept, check.approvalKey]);
    return true;
}

async function approveFromPreview(check: UnapprovedConfig): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
        APPROVAL_QUESTION, { modal: true, detail: `${check.configPath}\n\n${check.text}` }, ALLOW_ACTION);
    return choice === ALLOW_ACTION;
}

async function approveAfterReview(check: UnapprovedConfig): Promise<boolean> {
    const review = await vscode.window.showWarningMessage(APPROVAL_QUESTION, {
        modal: true,
        detail: `${check.configPath}\n\n${check.text.slice(0, PREVIEW_MAX_CHARS)}\n…\n\nThe file is too long to show here; open it to review all of it.`,
    }, REVIEW_ACTION);
    if (review !== REVIEW_ACTION) {
        return false;
    }
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(check.configPath), { preview: true });
    const choice = await vscode.window.showWarningMessage(
        APPROVAL_QUESTION, { modal: true, detail: `${check.configPath}, as opened in the editor.` }, ALLOW_ACTION);
    if (choice !== ALLOW_ACTION) {
        return false;
    }
    // Unsaved edits are what the user read, but acpx reads the file: approve only a buffer that is the file.
    if (editor.document.isDirty) {
        void vscode.window.showWarningMessage(DIRTY_REVIEW_MESSAGE);
        return false;
    }
    // The approval covers the bytes the user reviewed, not an edit made meanwhile.
    return currentApprovalKey(check) === check.approvalKey;
}

type UnapprovedConfig = Extract<ProjectConfigCheck, { status: 'unapproved' }>;

function currentApprovalKey(check: UnapprovedConfig): string | undefined {
    try {
        const bytes = readBoundedRegularFile(check.configPath);
        return bytes === undefined ? undefined : approvalKeyFor(path.dirname(check.configPath), bytes);
    } catch {
        return undefined;
    }
}

function approvalKeyFor(cwd: string, bytes: Buffer): string {
    return `${path.resolve(cwd)}\0${createHash('sha256').update(bytes).digest('hex')}`;
}

/** The file's bytes when it is a regular file within the cap, else undefined;
 *  throws ENOENT for a missing one. Symlinks are followed, as acpx does. */
function readBoundedRegularFile(filePath: string): Buffer | undefined {
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | OPEN_NON_BLOCKING);
    try {
        const stats = fs.fstatSync(fd);
        if (!stats.isFile() || stats.size > CONFIG_MAX_BYTES) {
            return undefined;
        }
        // One byte past the stat size shows a file that grew since.
        const bytes = readBoundedSync((buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position), CONFIG_MAX_BYTES, stats.size);
        return bytes.length > stats.size ? undefined : bytes;
    } finally {
        fs.closeSync(fd);
    }
}

function approvedKeys(): string[] {
    const stored = approvalStore.get(APPROVALS_KEY);
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : [];
}
