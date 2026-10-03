import * as vscode from 'vscode';
import { copyInstallCommand, openDashboard, openDocs, openNodeDocs, openOnboardDocs, openSecurityDocs, openUpdateDocs } from '../vscode/commands/docs';
import { getDashboardUrl } from '../vscode/config';
import { OPENCLAW_NPM_INSTALL } from '../core/setupOptions';

vi.mock('../vscode/config', () => ({ getDashboardUrl: vi.fn(() => 'http://127.0.0.1:18789/') } satisfies Partial<typeof import('../vscode/config')>));

const openExternal = vi.mocked(vscode.env.openExternal);
const showErrorMessage = vi.mocked(vscode.window.showErrorMessage);
const writeText = vi.mocked(vscode.env.clipboard.writeText);
const showInformationMessage = vi.mocked(vscode.window.showInformationMessage);
const dashboardUrl = vi.mocked(getDashboardUrl);

describe('docs commands', () => {
    beforeEach(() => {
        openExternal.mockReset().mockResolvedValue(undefined as never);
        showErrorMessage.mockReset().mockResolvedValue(undefined as never);
        showInformationMessage.mockReset().mockResolvedValue(undefined as never);
        writeText.mockReset().mockResolvedValue(undefined);
        dashboardUrl.mockReturnValue('http://127.0.0.1:18789/');
    });

    describe('openDashboard', () => {
        it.each([
            ['http://127.0.0.1:18789/', 'http://127.0.0.1:18789/'],
            ['https://gateway.example.net/', 'https://gateway.example.net/'],
        ])('opens the valid %s URL', async (configured, opened) => {
            dashboardUrl.mockReturnValue(configured);
            await openDashboard();
            expect(openExternal).toHaveBeenCalledTimes(1);
            expect(openExternal.mock.calls[0][0].toString()).toBe(opened);
            expect(showErrorMessage).not.toHaveBeenCalled();
        });

        it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'ws://127.0.0.1:18789/'])('refuses the %p scheme without opening anything', async (url) => {
            dashboardUrl.mockReturnValue(url);
            await openDashboard();
            expect(openExternal).not.toHaveBeenCalled();
            expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining(`scheme '${/^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]}'`));
            expect(showErrorMessage.mock.calls[0][0]).toContain('only http/https is allowed');
        });

        it('reports a URL that does not even parse', async () => {
            const parse = vscode.Uri.parse;
            (vscode.Uri as { parse: unknown }).parse = () => { throw new Error('bad uri'); };
            try {
                await openDashboard();
            } finally {
                vscode.Uri.parse = parse;
            }
            expect(openExternal).not.toHaveBeenCalled();
            expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Invalid OpenClaw dashboard URL'));
        });
    });

    describe('doc links', () => {
        it.each([
            ['openDocs', 'https://docs.openclaw.ai/'],
            ['openOnboardDocs', 'https://docs.openclaw.ai/start/wizard'],
            ['openUpdateDocs', 'https://docs.openclaw.ai/install/updating'],
            ['openSecurityDocs', 'https://docs.openclaw.ai/gateway/security'],
            ['openNodeDocs', 'https://nodejs.org/en/download'],
        ])('%s opens %s', async (name, url) => {
            await ({ openDocs, openOnboardDocs, openUpdateDocs, openSecurityDocs, openNodeDocs } as Record<string, () => Promise<void>>)[name]();
            expect(openExternal).toHaveBeenCalledTimes(1);
            expect(openExternal.mock.calls[0][0].toString()).toBe(url);
        });

        it('copyInstallCommand puts the npm install command on the clipboard', async () => {
            await copyInstallCommand();
            expect(writeText).toHaveBeenCalledWith(OPENCLAW_NPM_INSTALL);
            expect(showInformationMessage).toHaveBeenCalledWith('Install command copied to clipboard.');
        });
    });
});
