import * as vscode from 'vscode';
import { log } from './commands';

/** The IDs of builds installed before, or during, the rename to VSClaw; each is a different extension. */
export const LEGACY_EXTENSION_IDS = ['openknot.claw-code', 'openknot.vsclaw'] as const;

/**
 * The pre-rename build IDs that are installed, in a stable order. The lookup is injectable so the check is
 * tested without a VS Code host.
 */
export function detectLegacyExtensions(
    lookup: (id: string) => unknown = (id) => vscode.extensions.getExtension(id),
): string[] {
    return LEGACY_EXTENSION_IDS.filter((id) => Boolean(lookup(id)));
}

/**
 * Each pre-rename build is a different extension that contributes the same openclaw.* commands, settings and
 * views, so installing VSClaw is not an upgrade and each stays active. Warn once and offer to open the
 * Extensions view so the user can remove it (roadmap REL-2). The caller does not await it, so it cannot
 * delay activation.
 */
export async function warnAboutLegacyExtensions(installed: readonly string[]): Promise<void> {
    log.warn(`a build from before the rename is still installed: ${installed.join(', ')}`);
    const SHOW = 'Show Extensions';
    const choice = await vscode.window.showWarningMessage(
        `A build installed before the rename is still present (${installed.join(', ')}). It contributes the same commands and settings; remove it to avoid conflicts.`,
        SHOW
    );
    if (choice === SHOW) {
        void vscode.commands.executeCommand(
            'workbench.extensions.search',
            installed.map((id) => `@id:${id}`).join(' ')
        );
    }
}
