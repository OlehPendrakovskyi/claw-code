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

/** The action offered when a pre-rename build is installed, so the user can open the Extensions view. */
const SHOW_EXTENSIONS: vscode.MessageItem = { title: 'Show Extensions' };

/**
 * A pre-rename build is a different extension contributing the same openclaw.* commands, views and settings,
 * and VS Code gives each id one owner. So while one is present this build stays dormant (roadmap REL-2) and
 * this warning asks the user to remove it, then reload so this build can take over. The lookup of what to
 * remove is the caller's; this only presents it and, on request, opens the Extensions view filtered to the
 * installed pre-rename ids.
 */
export async function warnAboutLegacyExtensions(installed: readonly string[]): Promise<void> {
    log.warn(`a build from before the rename is still installed: ${installed.join(', ')}`);
    const choice = await vscode.window.showWarningMessage(
        `A build of this extension from before the rename is still installed (${installed.join(', ')}). VSClaw stays inactive until it is removed: uninstall it, then reload the window.`,
        SHOW_EXTENSIONS
    );
    if (choice?.title === SHOW_EXTENSIONS.title) {
        void vscode.commands.executeCommand(
            'workbench.extensions.search',
            installed.map((id) => `@id:${id}`).join(' ')
        );
    }
}
