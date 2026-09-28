import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

/** The one project-level file acpx 0.19.3 reads, from its `--cwd` (no parent
 *  walk, no opt-out flag): it can redefine agent commands and MCP servers. */
const PROJECT_CONFIG_NAME = '.acpxrc.json';

const APPROVALS_KEY = 'openclaw.acpx.approvedProjectConfigs';
const APPROVALS_MAX = 200;
const PREVIEW_MAX_CHARS = 2000;
const ALLOW_ACTION = 'Allow and Run';

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

/** Whether acpx may start in `cwd`: no project config, or one approved byte for byte. */
export function checkProjectConfig(cwd: string): ProjectConfigCheck {
    const configPath = path.join(path.resolve(cwd), PROJECT_CONFIG_NAME);
    let bytes: Buffer;
    try {
        bytes = fs.readFileSync(configPath);
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'trusted' } : { status: 'unreadable', configPath };
    }
    const approvalKey = `${path.resolve(cwd)}\0${createHash('sha256').update(bytes).digest('hex')}`;
    if (approvedKeys().includes(approvalKey)) {
        return { status: 'trusted' };
    }
    return { status: 'unapproved', configPath, approvalKey, text: bytes.toString('utf8') };
}

/** Asks the user, in a modal, to trust this exact config; remembers a yes. */
export async function requestProjectConfigApproval(check: Extract<ProjectConfigCheck, { status: 'unapproved' }>): Promise<boolean> {
    const preview = check.text.length > PREVIEW_MAX_CHARS ? `${check.text.slice(0, PREVIEW_MAX_CHARS)}\n…` : check.text;
    const choice = await vscode.window.showWarningMessage(
        'This workspace has an acpx config that can change which commands acpx runs for agents and MCP servers. Run acpx with it?',
        { modal: true, detail: `${check.configPath}\n\n${preview}` },
        ALLOW_ACTION
    );
    if (choice !== ALLOW_ACTION) {
        return false;
    }
    const kept = approvedKeys().filter(key => key !== check.approvalKey).slice(-(APPROVALS_MAX - 1));
    await approvalStore.update(APPROVALS_KEY, [...kept, check.approvalKey]);
    return true;
}

function approvedKeys(): string[] {
    const stored = approvalStore.get(APPROVALS_KEY);
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : [];
}
