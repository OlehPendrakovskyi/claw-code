import { replaceEnv } from './helpers/env';

vi.mock('../vscode/commands/shared', () => ({
    execFileAsync: vi.fn(),
    isOpenClawExecutable: vi.fn((executable: string) => executable === 'openclaw' || executable === 'openclaw.exe')
}));
vi.mock('../vscode/commands/setup', () => ({ isCommandAvailable: vi.fn(async () => true), showMissingNodeMessage: vi.fn(), runSetupFlow: vi.fn() }));
vi.mock('../vscode/commands/terminals', () => ({ getHardeningTerminal: vi.fn(), getOverviewProvider: vi.fn(() => undefined) }));
vi.mock('../vscode/config', () => ({ openHardeningSettings: vi.fn(), getDashboardUrl: vi.fn(() => 'http://127.0.0.1:18789') }));
vi.mock('../core/configIO', async () => ({
    ...await vi.importActual<typeof import('../core/configIO')>('../core/configIO'),
    getHardeningCommandPrefix: vi.fn(() => 'openclaw'),
    getHardeningMode: vi.fn(() => 'terminal'),
    getOpenClawConfigPath: vi.fn(() => '/home/u/.openclaw/openclaw.json'),
    readOpenClawConfig: vi.fn(async () => ({ config: {} })),
}));

import * as vscode from 'vscode';
import { getHardeningCommandPrefix } from '../core/configIO';
import { execFileAsync } from '../vscode/commands/shared';
import { showHardeningAccessSummary } from '../vscode/commands/hardening';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('hardening commands', () => {
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
