jest.mock('../vscode/commands/shared', () => ({ execFileAsync: jest.fn() }));
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
import { execFileAsync } from '../vscode/commands/shared';
import { showHardeningAccessSummary } from '../vscode/commands/hardening';

describe('hardening commands', () => {
    describe('showHardeningAccessSummary', () => {
        it('runs the status check with only the absolute PATH entries', async () => {
            Object.assign(vscode.workspace, { isTrusted: true });
            Object.assign(vscode.window, { showTextDocument: jest.fn() });
            jest.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as never);
            jest.mocked(execFileAsync).mockResolvedValue({ stdout: '', stderr: '' } as never);
            const env = jest.replaceProperty(process, 'env', { PATH: '.:node_modules/.bin:/usr/bin', HOME: '/home/u' });
            try {
                await showHardeningAccessSummary();
            } finally {
                env.restore();
            }
            expect(execFileAsync).toHaveBeenCalledWith('openclaw', ['status', '--all'], expect.objectContaining({ env: { PATH: '/usr/bin', HOME: '/home/u' } }));
        });
    });
});
