jest.mock('../vscode/commands/shared', () => ({
    execFileAsync: jest.fn(),
    isOpenClawExecutable: jest.fn((executable: string) => executable === 'openclaw' || executable === 'openclaw.exe')
}));
jest.mock('../vscode/commands/setup', () => ({ isCommandAvailable: jest.fn(async () => true), showMissingNodeMessage: jest.fn(), runSetupFlow: jest.fn() }));
jest.mock('../vscode/commands/terminals', () => ({ getHardeningTerminal: jest.fn(), getOverviewProvider: jest.fn(() => undefined) }));
jest.mock('../vscode/config', () => ({ openHardeningSettings: jest.fn(), getDashboardUrl: jest.fn(() => 'http://127.0.0.1:18789') }));
jest.mock('../core/configIO', () => ({
    ...jest.requireActual('../core/configIO'),
    getHardeningCommandPrefix: jest.fn(() => 'openclaw'),
    getHardeningMode: jest.fn(() => 'terminal'),
    getOpenClawConfigPath: jest.fn(() => '/home/u/.openclaw/openclaw.json'),
    readOpenClawConfig: jest.fn(async () => ({ config: {} })),
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
            Object.assign(vscode.window, { showTextDocument: jest.fn() });
            jest.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as never);
            jest.mocked(execFileAsync).mockReset().mockResolvedValue({ stdout: '', stderr: '' } as never);
            jest.mocked(getHardeningCommandPrefix).mockReturnValue('openclaw');
        });

        async function summarizeWith(env: NodeJS.ProcessEnv): Promise<void> {
            const replaced = jest.replaceProperty(process, 'env', env);
            try {
                await showHardeningAccessSummary();
            } finally {
                replaced.restore();
            }
        }

        // `sh` stands in for the CLI: /bin/sh exists on every POSIX machine, so the lookup needs no fixture files.
        posixOnly('runs the status check by absolute path, with only the absolute PATH entries', async () => {
            jest.mocked(getHardeningCommandPrefix).mockReturnValue('sh');
            await summarizeWith({ PATH: '.:node_modules/.bin:/bin', HOME: '/home/u' });
            expect(execFileAsync).toHaveBeenCalledWith('/bin/sh', ['status', '--all'], expect.objectContaining({ env: { PATH: '/bin', HOME: '/home/u' } }));
        });

        it('runs nothing when the command is on no absolute PATH entry', async () => {
            await summarizeWith({ PATH: '.:node_modules/.bin', HOME: '/home/u' });
            expect(execFileAsync).not.toHaveBeenCalled();
        });
    });
});
