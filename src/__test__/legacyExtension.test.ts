import * as vscode from 'vscode';
import { detectLegacyExtensions, warnAboutLegacyExtensions, LEGACY_EXTENSION_IDS } from '../vscode/legacyExtension';
import { log } from '../vscode/commands';

describe('legacy extension detection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('lists both pre-rename ids in a stable order when both are installed', () => {
        const installed = detectLegacyExtensions(id => ({ id }));
        expect(installed).toEqual(['openknot.claw-code', 'openknot.vsclaw']);
        expect(LEGACY_EXTENSION_IDS).toEqual(['openknot.claw-code', 'openknot.vsclaw']);
    });

    it('lists only the pre-rename ids that are installed', () => {
        expect(detectLegacyExtensions(id => (id === 'openknot.vsclaw' ? { id } : undefined)))
            .toEqual(['openknot.vsclaw']);
    });

    it('lists nothing when neither pre-rename build is installed', () => {
        expect(detectLegacyExtensions(() => undefined)).toEqual([]);
    });

    it('defaults the lookup to the vscode extension registry', () => {
        vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined);
        expect(detectLegacyExtensions()).toEqual([]);
        expect(vscode.extensions.getExtension).toHaveBeenCalledWith('openknot.claw-code');
    });
});

describe('legacy extension warning', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('warns once and offers to show the extensions', async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue({ title: 'Show Extensions' });
        await warnAboutLegacyExtensions(['openknot.claw-code']);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('openknot.claw-code'));
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('openknot.claw-code'),
            { title: 'Show Extensions' },
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'workbench.extensions.search',
            '@id:openknot.claw-code',
        );
    });

    it('searches for every installed pre-rename id at once', async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue({ title: 'Show Extensions' });
        await warnAboutLegacyExtensions(['openknot.claw-code', 'openknot.vsclaw']);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'workbench.extensions.search',
            '@id:openknot.claw-code @id:openknot.vsclaw',
        );
    });

    it('does not open the Extensions view when the user dismisses the warning', async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);
        await warnAboutLegacyExtensions(['openknot.claw-code']);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
});
