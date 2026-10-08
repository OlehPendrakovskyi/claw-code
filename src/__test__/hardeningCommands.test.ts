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
vi.mock('../core/cliLauncher', async () => {
    const actual = await vi.importActual<typeof import('../core/cliLauncher')>('../core/cliLauncher');
    return { ...actual, resolveCommandLaunch: vi.fn(actual.resolveCommandLaunch) } satisfies Partial<typeof import('../core/cliLauncher')>;
});
vi.mock('../core/hardeningCommand', async () => {
    const actual = await vi.importActual<typeof import('../core/hardeningCommand')>('../core/hardeningCommand');
    return { ...actual, splitHardeningCommand: vi.fn(actual.splitHardeningCommand) } satisfies Partial<typeof import('../core/hardeningCommand')>;
});

import * as vscode from 'vscode';
import { getHardeningCommandPrefix, getHardeningMode, loadOpenClawConfigRecord, readOpenClawConfig, writeOpenClawConfigRecord } from '../core/configIO';
import { resolveCommandLaunch } from '../core/cliLauncher';
import { splitHardeningCommand } from '../core/hardeningCommand';
import { execFileAsync } from '../vscode/commands/shared';
import { getHardeningTerminal, getOverviewProvider } from '../vscode/commands/terminals';
import { isCommandAvailable, runSetupFlow, showMissingNodeMessage } from '../vscode/commands/setup';
import { openHardeningSettings } from '../vscode/config';
import {
    ensureHardeningCommandReady,
    runHardeningFlow,
    runHardeningStatusCheck,
    showHardeningAccessSummary,
    toggleToolEntry,
    uninstallToolEntry
} from '../vscode/commands/hardening';
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

    describe('ensureHardeningCommandReady', () => {
        beforeEach(() => {
            resetHardeningMocks();
        });

        it('rejects a command with shell metacharacters and opens the hardening settings', async () => {
            vi.mocked(getHardeningCommandPrefix).mockReturnValue('openclaw; rm -rf ~');

            await expect(ensureHardeningCommandReady()).resolves.toBeNull();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('OpenClaw hardening command is invalid'));
            expect(openHardeningSettings).toHaveBeenCalledOnce();
            expect(isCommandAvailable).not.toHaveBeenCalled();
        });

        it('refuses to run in an untrusted workspace without offering settings', async () => {
            Object.assign(vscode.workspace, { isTrusted: false });

            await expect(ensureHardeningCommandReady()).resolves.toBeNull();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'OpenClaw hardening commands are disabled in untrusted workspaces. Trust this workspace and retry.'
            );
            expect(openHardeningSettings).not.toHaveBeenCalled();
            expect(isCommandAvailable).not.toHaveBeenCalled();
        });

        it('asks for Node.js when the OpenClaw CLI is configured and node is missing', async () => {
            vi.mocked(isCommandAvailable).mockImplementation(async (command: string) => command !== 'node');

            await expect(ensureHardeningCommandReady()).resolves.toBeNull();

            expect(isCommandAvailable).toHaveBeenCalledWith('node');
            expect(showMissingNodeMessage).toHaveBeenCalledOnce();
            expect(isCommandAvailable).not.toHaveBeenCalledWith('openclaw');
        });

        it('does not require Node.js for a command that is not the OpenClaw CLI', async () => {
            vi.mocked(getHardeningCommandPrefix).mockReturnValue('mytool --profile dev');
            vi.mocked(getHardeningMode).mockReturnValue('auditFix');

            await expect(ensureHardeningCommandReady()).resolves.toEqual({ prefix: 'mytool --profile dev', mode: 'auditFix' });

            expect(isCommandAvailable).toHaveBeenCalledTimes(1);
            expect(isCommandAvailable).toHaveBeenCalledWith('mytool');
        });

        it('checks node and then the CLI before reporting the command ready', async () => {
            vi.mocked(getHardeningMode).mockReturnValue('full');

            await expect(ensureHardeningCommandReady()).resolves.toEqual({ prefix: 'openclaw', mode: 'full' });

            expect(vi.mocked(isCommandAvailable).mock.calls).toEqual([['node'], ['openclaw']]);
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        });

        describe('when the executable is not found', () => {
            beforeEach(() => {
                vi.mocked(getHardeningCommandPrefix).mockReturnValue('mytool');
                vi.mocked(isCommandAvailable).mockResolvedValue(false);
            });

            it('offers to install the CLI or open settings', async () => {
                await expect(ensureHardeningCommandReady()).resolves.toBeNull();

                expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                    'Command not found: mytool. Update OpenClaw: Hardening Command or install the OpenClaw CLI.',
                    'Install CLI',
                    'Open settings'
                );
                expect(runSetupFlow).not.toHaveBeenCalled();
                expect(openHardeningSettings).not.toHaveBeenCalled();
            });

            it('runs the setup flow when Install CLI is picked', async () => {
                vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce('Install CLI' as never);

                await expect(ensureHardeningCommandReady()).resolves.toBeNull();

                expect(runSetupFlow).toHaveBeenCalledOnce();
                expect(openHardeningSettings).not.toHaveBeenCalled();
            });

            it('opens the hardening settings when Open settings is picked', async () => {
                vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce('Open settings' as never);

                await expect(ensureHardeningCommandReady()).resolves.toBeNull();

                expect(openHardeningSettings).toHaveBeenCalledOnce();
                expect(runSetupFlow).not.toHaveBeenCalled();
            });
        });
    });

    describe('runHardeningFlow', () => {
        let terminal: { show: ReturnType<typeof vi.fn>; sendText: ReturnType<typeof vi.fn> };

        beforeEach(() => {
            resetHardeningMocks();
            terminal = useHardeningTerminal();
        });

        it.each([
            ['audit', ['openclaw security audit']],
            ['auditFix', ['openclaw security audit', 'openclaw security audit --fix']],
            ['full', ['openclaw security audit', 'openclaw security audit --fix', 'openclaw security audit --deep']]
        ] as const)('sends the %s mode commands to the hardening terminal in order', async (mode, expected) => {
            vi.mocked(getHardeningMode).mockReturnValue(mode);

            await runHardeningFlow();

            expect(terminal.show).toHaveBeenCalledWith(true);
            expect(terminal.sendText.mock.calls.map(([text]) => text)).toEqual(expected);
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('OpenClaw hardening commands sent. Review the terminal output.');
        });

        it('records the run time on the overview', async () => {
            const setLastRun = vi.fn();
            vi.mocked(getOverviewProvider).mockReturnValue({ setLastRun } as unknown as ReturnType<typeof getOverviewProvider>);

            await runHardeningFlow();

            expect(setLastRun).toHaveBeenCalledWith(expect.any(Date));
        });

        it('sends nothing when the command is not ready', async () => {
            vi.mocked(getHardeningCommandPrefix).mockReturnValue('openclaw; rm');

            await runHardeningFlow();

            expect(getHardeningTerminal).not.toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });
    });

    describe('runHardeningStatusCheck', () => {
        let terminal: { show: ReturnType<typeof vi.fn>; sendText: ReturnType<typeof vi.fn> };

        beforeEach(() => {
            resetHardeningMocks();
            terminal = useHardeningTerminal();
        });

        it('sends status --all with the configured prefix', async () => {
            vi.mocked(getHardeningCommandPrefix).mockReturnValue('openclaw --profile dev');

            await runHardeningStatusCheck();

            expect(terminal.show).toHaveBeenCalledWith(true);
            expect(terminal.sendText).toHaveBeenCalledExactlyOnceWith('openclaw --profile dev status --all');
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Running OpenClaw status --all.');
        });

        it('sends nothing when the command is not ready', async () => {
            Object.assign(vscode.workspace, { isTrusted: false });

            await runHardeningStatusCheck();

            expect(getHardeningTerminal).not.toHaveBeenCalled();
        });
    });

    describe('access summary', () => {
        const setAccessSummary = vi.fn();

        beforeEach(() => {
            resetHardeningMocks();
            setAccessSummary.mockReset();
            vi.mocked(getOverviewProvider).mockReturnValue({ setAccessSummary } as unknown as ReturnType<typeof getOverviewProvider>);
            Object.assign(vscode.window, { showTextDocument: vi.fn() });
            vi.mocked(vscode.workspace.openTextDocument).mockReset().mockResolvedValue({ uri: 'doc' } as never);
            vi.mocked(execFileAsync).mockReset().mockResolvedValue({ stdout: '', stderr: '' } as never);
            vi.mocked(readOpenClawConfig).mockReset().mockResolvedValue({ config: {} });
            vi.mocked(resolveCommandLaunch).mockReturnValue({ command: '/opt/bin/openclaw', args: [] });
        });

        afterEach(() => {
            vi.mocked(getOverviewProvider).mockReturnValue(undefined);
            vi.mocked(resolveCommandLaunch).mockImplementation(actualResolveCommandLaunch);
        });

        async function summary(): Promise<{ short: string; markdown: string; generatedAt: Date }> {
            await showHardeningAccessSummary();
            expect(setAccessSummary).toHaveBeenCalledOnce();
            const [result] = setAccessSummary.mock.calls[0] as [{ short: string; markdown: string; generatedAt: Date }];
            return result;
        }

        it('opens the markdown summary and hands it to the overview', async () => {
            vi.mocked(readOpenClawConfig).mockResolvedValue({ config: { mcpServers: { files: { command: 'mcp-files' } } } });
            vi.mocked(execFileAsync).mockResolvedValue({ stdout: 'Gateway: up\n', stderr: 'warning: slow' } as never);

            const result = await summary();

            expect(readOpenClawConfig).toHaveBeenCalledWith('/home/u/.openclaw/openclaw.json');
            expect(execFileAsync).toHaveBeenCalledWith(
                '/opt/bin/openclaw',
                ['status', '--all'],
                expect.objectContaining({ maxBuffer: 1024 * 1024 })
            );
            expect(result.generatedAt).toBeInstanceOf(Date);
            expect(result.markdown).toContain('```\nGateway: up\n\nwarning: slow\n```');
            expect(result.markdown).toContain('- http://127.0.0.1:18789');
            expect(result.markdown).toContain('/home/u/.openclaw/openclaw.json');
            expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ content: result.markdown, language: 'markdown' });
            expect(vscode.window.showTextDocument).toHaveBeenCalledWith({ uri: 'doc' }, { preview: true });
        });

        it('runs a launcher prefix and the configured arguments before status --all', async () => {
            vi.mocked(getHardeningCommandPrefix).mockReturnValue('openclaw --profile "my dev"');
            vi.mocked(resolveCommandLaunch).mockReturnValue({ command: '/usr/bin/node', args: ['/opt/lib/openclaw.mjs'] });

            await showHardeningAccessSummary();

            expect(resolveCommandLaunch).toHaveBeenCalledWith('openclaw');
            expect(execFileAsync).toHaveBeenCalledWith(
                '/usr/bin/node',
                ['/opt/lib/openclaw.mjs', '--profile', 'my dev', 'status', '--all'],
                expect.objectContaining({ maxBuffer: 1024 * 1024 })
            );
        });

        it('lists CLI-reported endpoints redacted, sorted and alongside the dashboard', async () => {
            vi.mocked(execFileAsync).mockResolvedValue({ stdout: 'Gateway: https://gw.example.com/ws?token=abc123', stderr: '' } as never);

            const result = await summary();

            const endpoints = result.markdown.split('## Network endpoints\n')[1]?.split('\n\n')[0];
            expect(endpoints).toBe('- http://127.0.0.1:18789\n- https://gw.example.com/ws?token=***');
            expect(result.markdown).not.toContain('abc123');
        });

        it('notes that no CLI output was captured when the command prints nothing', async () => {
            vi.mocked(execFileAsync).mockResolvedValue({ stdout: '  \n', stderr: '' } as never);

            const result = await summary();

            expect(result.markdown).toContain('No CLI output captured.');
            expect(result.short).not.toContain('CLI error');
        });

        it('reports a config read failure', async () => {
            vi.mocked(readOpenClawConfig).mockResolvedValue({ config: null, error: 'Config file not found.' });

            const result = await summary();

            expect(result.short).toContain('Config unavailable');
            expect(result.markdown).toContain('Config issue: Config file not found.');
        });

        it('redacts credentials from a failed status run', async () => {
            vi.mocked(execFileAsync).mockRejectedValue(new Error('Command failed: https://alice:s3cr3t@gw.example.com/x?token=abc123 password=hunter2'));

            const result = await summary();

            expect(result.short).toContain('CLI error');
            expect(result.markdown).toContain('CLI issue: Command failed:');
            expect(result.markdown).not.toContain('s3cr3t');
            expect(result.markdown).not.toContain('abc123');
            expect(result.markdown).not.toContain('hunter2');
        });

        it('reports a CLI shim whose Node.js is missing without running anything', async () => {
            vi.mocked(resolveCommandLaunch).mockReturnValue({ missing: 'node' });

            const result = await summary();

            expect(execFileAsync).not.toHaveBeenCalled();
            expect(result.markdown).toContain('CLI issue: Hardening command openclaw needs Node.js, found on no absolute PATH entry.');
        });

        it('reports a CLI that is on no absolute PATH entry without running anything', async () => {
            vi.mocked(resolveCommandLaunch).mockReturnValue({ missing: 'openclaw' });

            const result = await summary();

            expect(execFileAsync).not.toHaveBeenCalled();
            expect(result.markdown).toContain('CLI issue: Hardening command not found: openclaw is on no absolute PATH entry.');
        });

        it('refuses to run a command that no longer parses', async () => {
            // The readiness check parses the prefix first; the status run re-parses it defensively.
            vi.mocked(splitHardeningCommand).mockReturnValueOnce({ executable: 'openclaw', args: [] }).mockReturnValueOnce(null);

            const result = await summary();

            expect(execFileAsync).not.toHaveBeenCalled();
            expect(result.markdown).toContain('CLI issue: Hardening command is invalid (shell metacharacters or unbalanced quotes are not allowed).');
        });

        it('opens nothing when the command is not ready', async () => {
            vi.mocked(getHardeningCommandPrefix).mockReturnValue('openclaw; rm');

            await showHardeningAccessSummary();

            expect(readOpenClawConfig).not.toHaveBeenCalled();
            expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
        });

        it('still opens the summary when no overview is registered', async () => {
            vi.mocked(getOverviewProvider).mockReturnValue(undefined);

            await showHardeningAccessSummary();

            expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ language: 'markdown' }));
        });
    });

    describe('tool entry edits', () => {
        const configPath = '/home/u/.openclaw/openclaw.json';
        const refreshTools = vi.fn(async () => undefined);

        beforeEach(() => {
            resetHardeningMocks();
            refreshTools.mockClear();
            vi.mocked(getOverviewProvider).mockReturnValue({ refreshTools } as unknown as ReturnType<typeof getOverviewProvider>);
        });

        afterEach(() => {
            vi.mocked(getOverviewProvider).mockReturnValue(undefined);
        });

        function useConfig(config: Record<string, unknown>): void {
            vi.mocked(loadOpenClawConfigRecord).mockResolvedValue({ config, path: configPath });
        }

        function expectNoWrite(): void {
            expect(writeOpenClawConfigRecord).not.toHaveBeenCalled();
            expect(refreshTools).not.toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        }

        it('shows the load error when the config cannot be read', async () => {
            vi.mocked(loadOpenClawConfigRecord).mockResolvedValue({ config: null, error: 'Config file is not valid JSON.', path: configPath });

            await toggleToolEntry({ id: 'fmt', label: 'fmt', enabled: true, path: ['tools', 0], source: 'tools' });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Config file is not valid JSON.');
            expectNoWrite();
        });

        it('falls back to a not-found message when the config is missing without an error', async () => {
            vi.mocked(loadOpenClawConfigRecord).mockResolvedValue({ config: null, path: configPath });

            await uninstallToolEntry({ id: 'fmt', label: 'fmt', enabled: true, path: ['tools', 0], source: 'tools' });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('OpenClaw config not found.');
            expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
            expectNoWrite();
        });

        it('reports a tool whose path no longer resolves in the config', async () => {
            useConfig({ tools: { fmt: true } });

            await toggleToolEntry({ id: 'fmt', label: 'fmt', enabled: true, path: ['tools', 0], source: 'tools' });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Unable to locate tool "fmt" in config.');
            expectNoWrite();
        });

        it('reports a tool entry that is missing from its list', async () => {
            useConfig({ tools: [] });

            await toggleToolEntry({ id: 'fmt', label: 'fmt', enabled: true, path: ['tools', 3], source: 'tools' });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Unable to locate tool "fmt" in config.');
            expectNoWrite();
        });

        it('refuses to toggle a tool entry in an unsupported format', async () => {
            useConfig({ tools: [42] });

            await toggleToolEntry({ id: '42', label: 'odd', enabled: true, path: ['tools', 0], source: 'tools' });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Tool "odd" has an unsupported format.');
            expectNoWrite();
        });

        it('enables a disabled tool keyed by name and confirms it', async () => {
            const config = { tools: { fmt: { enabled: false, command: 'fmt' } } };
            useConfig(config);

            await toggleToolEntry({ id: 'fmt', label: 'fmt', enabled: false, path: ['tools', 'fmt'], source: 'tools' });

            expect(writeOpenClawConfigRecord).toHaveBeenCalledWith(configPath, { tools: { fmt: { enabled: true, command: 'fmt' } } });
            expect(refreshTools).toHaveBeenCalledOnce();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Enabled tool "fmt".');
        });

        it('disables a tool listed by bare name', async () => {
            useConfig({ tools: ['fmt'] });

            await toggleToolEntry({ id: 'fmt', label: 'fmt', enabled: true, path: ['tools', 0], source: 'tools' });

            expect(writeOpenClawConfigRecord).toHaveBeenCalledWith(configPath, { tools: [{ name: 'fmt', enabled: false }] });
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Disabled tool "fmt".');
        });

        it('removes a listed tool after confirmation', async () => {
            useConfig({ tools: ['lint', 'fmt', 'test'] });
            vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Remove' as never);

            await uninstallToolEntry({ id: 'fmt', label: 'fmt', enabled: true, path: ['tools', 1], source: 'tools' });

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Remove "fmt" from OpenClaw tools?', { modal: true }, 'Remove');
            expect(writeOpenClawConfigRecord).toHaveBeenCalledWith(configPath, { tools: ['lint', 'test'] });
            expect(refreshTools).toHaveBeenCalledOnce();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Removed tool "fmt".');
        });

        it('removes a tool keyed by name after confirmation', async () => {
            useConfig({ tools: { fmt: true, lint: true } });
            vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Remove' as never);

            await uninstallToolEntry({ id: 'fmt', label: 'fmt', enabled: true, path: ['tools', 'fmt'], source: 'tools' });

            expect(writeOpenClawConfigRecord).toHaveBeenCalledWith(configPath, { tools: { lint: true } });
        });

        it('leaves the config untouched when removal is cancelled', async () => {
            useConfig({ tools: ['fmt'] });
            vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);

            await uninstallToolEntry({ id: 'fmt', label: 'fmt', enabled: true, path: ['tools', 0], source: 'tools' });

            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
            expectNoWrite();
        });

        it('writes and confirms even when no overview is registered', async () => {
            vi.mocked(getOverviewProvider).mockReturnValue(undefined);
            useConfig({ tools: ['fmt'] });

            await toggleToolEntry({ id: 'fmt', label: 'fmt', enabled: true, path: ['tools', 0], source: 'tools' });

            expect(writeOpenClawConfigRecord).toHaveBeenCalledOnce();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Disabled tool "fmt".');
        });
    });
});

const actualResolveCommandLaunch = (await vi.importActual<typeof import('../core/cliLauncher')>('../core/cliLauncher')).resolveCommandLaunch;
const actualSplitHardeningCommand = (await vi.importActual<typeof import('../core/hardeningCommand')>('../core/hardeningCommand')).splitHardeningCommand;

/** Clears call history and restores the default ready-to-run state between tests. */
function resetHardeningMocks(): void {
    vi.clearAllMocks();
    Object.assign(vscode.workspace, { isTrusted: true });
    vi.mocked(vscode.window.showInformationMessage).mockReset();
    vi.mocked(vscode.window.showErrorMessage).mockReset();
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    vi.mocked(getHardeningCommandPrefix).mockReturnValue('openclaw');
    vi.mocked(getHardeningMode).mockReturnValue('audit');
    vi.mocked(isCommandAvailable).mockReset().mockResolvedValue(true);
    vi.mocked(splitHardeningCommand).mockReset().mockImplementation(actualSplitHardeningCommand);
}

/** Hands the code under test a fake hardening terminal and returns it for assertions. */
function useHardeningTerminal(): { show: ReturnType<typeof vi.fn>; sendText: ReturnType<typeof vi.fn> } {
    const terminal = { show: vi.fn(), sendText: vi.fn() };
    vi.mocked(getHardeningTerminal).mockReturnValue(terminal as unknown as ReturnType<typeof getHardeningTerminal>);
    return terminal;
}
