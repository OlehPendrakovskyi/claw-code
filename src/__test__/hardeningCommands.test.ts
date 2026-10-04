import { replaceEnv } from './helpers/env';

vi.mock('../vscode/commands/shared', () => ({
    execFileAsync: vi.fn(),
    isOpenClawExecutable: vi.fn((executable: string) => executable === 'openclaw' || executable === 'openclaw.exe') as unknown as typeof import('../vscode/commands/shared').isOpenClawExecutable
} satisfies Partial<typeof import('../vscode/commands/shared')>));
vi.mock('../vscode/commands/setup', () => ({ isCommandAvailable: vi.fn(async () => true), showMissingNodeMessage: vi.fn(), runSetupFlow: vi.fn() } satisfies Partial<typeof import('../vscode/commands/setup')>));
vi.mock('../vscode/commands/terminals', () => ({ getHardeningTerminal: vi.fn(), getOverviewProvider: vi.fn(() => undefined) } satisfies Partial<typeof import('../vscode/commands/terminals')>));
vi.mock('../vscode/config', () => ({ openHardeningSettings: vi.fn(), getDashboardUrl: vi.fn(() => 'http://127.0.0.1:18789') } satisfies Partial<typeof import('../vscode/config')>));
vi.mock('../core/configIO', async () => ({
    ...await vi.importActual<typeof import('../core/configIO')>('../core/configIO'),
    getHardeningCommandPrefix: vi.fn(() => 'openclaw'),
    getHardeningMode: vi.fn(() => 'terminal'),
    getOpenClawConfigPath: vi.fn(() => '/home/u/.openclaw/openclaw.json'),
    readOpenClawConfig: vi.fn(async () => ({ config: {} })),
    loadOpenClawConfigRecord: vi.fn(),
    writeOpenClawConfigRecord: vi.fn(async () => undefined),
}));

import * as vscode from 'vscode';
import { getHardeningCommandPrefix, loadOpenClawConfigRecord, writeOpenClawConfigRecord } from '../core/configIO';
import { execFileAsync } from '../vscode/commands/shared';
import { getOverviewProvider } from '../vscode/commands/terminals';
import { showHardeningAccessSummary, toggleToolEntry } from '../vscode/commands/hardening';
import type { ToolEntry } from '../core/tools';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('hardening commands', () => {
    describe('toggleToolEntry', () => {
        const tool: ToolEntry = { id: 'fmt', label: 'fmt', enabled: true, path: ['tools', 0], source: 'tools' };

        beforeEach(() => {
            vi.mocked(loadOpenClawConfigRecord).mockResolvedValue({ config: { tools: [{ name: 'fmt', enabled: true }] }, path: '/home/u/.openclaw/openclaw.json' });
            vi.mocked(vscode.window.showInformationMessage).mockClear();
        });

        afterEach(() => {
            vi.mocked(getOverviewProvider).mockReturnValue(undefined);
        });

        it('confirms the change only after the tools view has refreshed', async () => {
            const order: string[] = [];
            const refreshTools = vi.fn(async () => {
                await Promise.resolve();
                order.push('refreshed');
            });
            vi.mocked(getOverviewProvider).mockReturnValue({ refreshTools } as unknown as ReturnType<typeof getOverviewProvider>);
            vi.mocked(vscode.window.showInformationMessage).mockImplementation(async () => {
                order.push('confirmed');
                return undefined;
            });

            await toggleToolEntry(tool);

            expect(writeOpenClawConfigRecord).toHaveBeenCalledWith('/home/u/.openclaw/openclaw.json', { tools: [{ name: 'fmt', enabled: false }] });
            expect(order).toEqual(['refreshed', 'confirmed']);
        });

        it('surfaces a failed refresh instead of leaving it unhandled', async () => {
            const refreshTools = vi.fn(async () => {
                throw new Error('tree refresh failed');
            });
            vi.mocked(getOverviewProvider).mockReturnValue({ refreshTools } as unknown as ReturnType<typeof getOverviewProvider>);

            await expect(toggleToolEntry(tool)).rejects.toThrow('tree refresh failed');
            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });
    });

    describe('showHardeningAccessSummary', () => {
        beforeEach(() => {
            Object.assign(vscode.workspace, { isTrusted: true });
            Object.assign(vscode.window, { showTextDocument: vi.fn() });
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as never);
            vi.mocked(execFileAsync).mockReset().mockResolvedValue({ stdout: '', stderr: '' } as never);
            vi.mocked(getHardeningCommandPrefix).mockReturnValue('openclaw');
        });

        async function summarizeWith(env: NodeJS.ProcessEnv): Promise<void> {
            const replaced = replaceEnv(env);
            try {
                await showHardeningAccessSummary();
            } finally {
                replaced.restore();
            }
        }

        // `sh` stands in for the CLI: /bin/sh exists on every POSIX machine, so the lookup needs no fixture files.
        posixOnly('runs the status check by absolute path, with only the absolute PATH entries', async () => {
            vi.mocked(getHardeningCommandPrefix).mockReturnValue('sh');
            await summarizeWith({ PATH: '.:node_modules/.bin:/bin', HOME: '/home/u' });
            expect(execFileAsync).toHaveBeenCalledWith('/bin/sh', ['status', '--all'], expect.objectContaining({ env: { PATH: '/bin', HOME: '/home/u' } }));
        });

        it('runs nothing when the command is on no absolute PATH entry', async () => {
            await summarizeWith({ PATH: '.:node_modules/.bin', HOME: '/home/u' });
            expect(execFileAsync).not.toHaveBeenCalled();
        });
    });
});
