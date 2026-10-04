import type { Mock } from 'vitest';

// Fake terminals shared by the terminals mock and the assertions; hoisted so the
// factory below can reach them.
const terminals = vi.hoisted(() => ({
    setup: { show: vi.fn(), sendText: vi.fn(), dispose: vi.fn() },
    openclaw: { show: vi.fn(), sendText: vi.fn(), dispose: vi.fn() },
}));

// Rule 50: every mock spreads the real module and overrides only the side-effecting
// members, so any export setup.ts reaches is defined.
vi.mock('../vscode/commands/shared', async () => ({
    ...await vi.importActual<typeof import('../vscode/commands/shared')>('../vscode/commands/shared'),
    execFileAsync: vi.fn() as unknown as typeof import('../vscode/commands/shared').execFileAsync,
    copyToClipboard: vi.fn(async () => undefined),
} satisfies typeof import('../vscode/commands/shared')));
vi.mock('../vscode/commands/terminals', async () => ({
    ...await vi.importActual<typeof import('../vscode/commands/terminals')>('../vscode/commands/terminals'),
    getSetupTerminal: vi.fn(() => terminals.setup as unknown as import('vscode').Terminal),
    getOpenClawTerminal: vi.fn(() => terminals.openclaw as unknown as import('vscode').Terminal),
} satisfies typeof import('../vscode/commands/terminals')));
vi.mock('../vscode/commands/docs', async () => ({
    ...await vi.importActual<typeof import('../vscode/commands/docs')>('../vscode/commands/docs'),
    copyInstallCommand: vi.fn(async () => undefined),
    openDocs: vi.fn(async () => undefined),
    openOnboardDocs: vi.fn(async () => undefined),
    openDashboard: vi.fn(async () => undefined),
    openUpdateDocs: vi.fn(async () => undefined),
    openNodeDocs: vi.fn(async () => undefined),
} satisfies typeof import('../vscode/commands/docs')));
vi.mock('../vscode/config', async () => ({
    ...await vi.importActual<typeof import('../vscode/config')>('../vscode/config'),
    openOpenClawConfig: vi.fn(async () => undefined),
    openAuthProfiles: vi.fn(async () => undefined),
    openSettings: vi.fn(async () => undefined),
} satisfies typeof import('../vscode/config')));
vi.mock('../vscode/statusbar', async () => ({
    ...await vi.importActual<typeof import('../vscode/statusbar')>('../vscode/statusbar'),
    setStatus: vi.fn(),
} satisfies typeof import('../vscode/statusbar')));
// Real options by default; individual tests swap in a malformed list to reach the guards.
vi.mock('../core/setupOptions', async () => {
    const actual = await vi.importActual<typeof import('../core/setupOptions')>('../core/setupOptions');
    return {
        ...actual,
        getInstallOptions: vi.fn(actual.getInstallOptions),
        getNodeInstallOptions: vi.fn(actual.getNodeInstallOptions),
        getNodeInstallCommandForPlatform: vi.fn(actual.getNodeInstallCommandForPlatform),
    } satisfies typeof import('../core/setupOptions');
});

import * as vscode from 'vscode';
import { usePlatform } from './helpers/platform';
import { replaceEnv } from './helpers/env';
import {
    OPENCLAW_INSTALL_PS1,
    OPENCLAW_INSTALL_SCRIPT,
    OPENCLAW_NPM_INSTALL,
    getInstallOptions,
    getNodeInstallCommandForPlatform,
    getNodeInstallOptions,
} from '../core/setupOptions';
import { copyToClipboard, execFileAsync } from '../vscode/commands/shared';
import { copyInstallCommand, openDashboard, openDocs, openNodeDocs, openOnboardDocs, openUpdateDocs } from '../vscode/commands/docs';
import { openAuthProfiles, openOpenClawConfig, openSettings } from '../vscode/config';
import { setStatus } from '../vscode/statusbar';
import {
    connect,
    runCliInTerminal,
    runModelSetupWizard,
    runNodeSetupFlow,
    runSetupFlow,
    showMissingNodeMessage,
    updateOpenClawCommandSetting,
} from '../vscode/commands/setup';

type PickItem = vscode.QuickPickItem;
type QuickPickFn = (items: readonly PickItem[], options?: vscode.QuickPickOptions) => Promise<PickItem | undefined>;
type MessageFn = (message: string, ...rest: unknown[]) => Promise<string | undefined>;

const quickPick = vi.mocked(vscode.window.showQuickPick) as unknown as Mock<QuickPickFn>;
const errorMessage = vi.mocked(vscode.window.showErrorMessage) as unknown as Mock<MessageFn>;
const warningMessage = vi.mocked(vscode.window.showWarningMessage) as unknown as Mock<MessageFn>;
const infoMessage = vi.mocked(vscode.window.showInformationMessage) as unknown as Mock<MessageFn>;
const getConfiguration = vi.mocked(vscode.workspace.getConfiguration);
const openExternal = vi.mocked(vscode.env.openExternal);
const probe = vi.mocked(execFileAsync) as unknown as Mock<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>;

const LINUX_NODE = 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs';

/** Make exactly these commands resolve on the PATH probe; the probed name is the last argument on every platform. */
function setAvailable(...commands: string[]) {
    probe.mockImplementation(async (_file, args) => {
        const command = args[args.length - 1];
        if (commands.includes(command)) {
            return { stdout: '', stderr: '' };
        }
        throw new Error(`not found: ${command}`);
    });
}

/** The commands the PATH probe was asked about, in order. */
function probed(): string[] {
    return probe.mock.calls.map(([, args]) => args[args.length - 1]);
}

/** Script misuse caught inside code that swallows errors (connect's catch) is recorded here and fails the test in afterEach. */
const scriptFailures: string[] = [];

function fail(message: string): never {
    scriptFailures.push(message);
    throw new Error(message);
}

/** Answer successive quick picks by label; `undefined` dismisses. A label that was not offered fails the test. */
function answerPicks(...labels: (string | undefined)[]) {
    quickPick.mockImplementation(async items => {
        if (labels.length === 0) {
            fail(`unexpected quick pick: ${items.map(item => item.label).join(', ')}`);
        }
        const label = labels.shift();
        if (label === undefined) {
            return undefined;
        }
        const item = items.find(candidate => candidate.label === label);
        if (!item) {
            fail(`"${label}" not offered; got ${items.map(candidate => candidate.label).join(', ')}`);
        }
        return item;
    });
}

/** Answer successive prompts of one message kind by button; `undefined` dismisses. A button that was not offered fails the test. */
function answerButtons(fn: Mock<MessageFn>, ...buttons: (string | undefined)[]) {
    fn.mockImplementation(async (message, ...rest) => {
        if (buttons.length === 0) {
            return undefined;
        }
        const button = buttons.shift();
        const offered = rest.filter((entry): entry is string => typeof entry === 'string');
        if (button !== undefined && !offered.includes(button)) {
            fail(`"${button}" not offered for "${message}"; got ${offered.join(', ')}`);
        }
        return button;
    });
}

/** Labels offered by the nth quick pick. */
function pickLabels(index: number): string[] {
    return quickPick.mock.calls[index][0].map(item => item.label);
}

/** Buttons offered by the nth call of a message function. */
function buttonsOf(fn: Mock<MessageFn>, index: number): unknown[] {
    return fn.mock.calls[index].slice(1).filter(entry => typeof entry === 'string');
}

function useCommandSetting(command: string | undefined) {
    const update = vi.fn(async () => undefined);
    getConfiguration.mockReturnValue({
        get: vi.fn(() => command),
        update,
        inspect: vi.fn(() => undefined),
    } as unknown as ReturnType<typeof getConfiguration>);
    return update;
}

describe('setup flows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        quickPick.mockReset();
        errorMessage.mockReset();
        warningMessage.mockReset();
        infoMessage.mockReset();
        probe.mockReset();
        getConfiguration.mockReset();
        useCommandSetting(undefined);
        scriptFailures.length = 0;
    });

    afterEach(() => {
        expect(scriptFailures).toEqual([]);
    });

    describe('connect', () => {
        usePlatform('linux');

        it('sends the default status command to the OpenClaw terminal when node and the CLI are present', async () => {
            setAvailable('node', 'openclaw');

            await connect();

            expect(probed()).toEqual(['node', 'openclaw']);
            expect(vi.mocked(setStatus).mock.calls).toEqual([['connecting'], ['connected']]);
            expect(terminals.openclaw.show).toHaveBeenCalledWith(true);
            expect(terminals.openclaw.sendText).toHaveBeenCalledWith('openclaw status');
            expect(infoMessage).toHaveBeenCalledWith('OpenClaw command sent.');
        });

        it('falls back to the default command when the setting is blank', async () => {
            useCommandSetting('   ');
            setAvailable('node', 'openclaw');

            await connect();

            expect(terminals.openclaw.sendText).toHaveBeenCalledWith('openclaw status');
        });

        it('runs a custom executable without requiring node', async () => {
            useCommandSetting('  mytool --flag  ');
            setAvailable('mytool');

            await connect();

            expect(probed()).toEqual(['mytool']);
            expect(terminals.openclaw.sendText).toHaveBeenCalledWith('mytool --flag');
            expect(setStatus).toHaveBeenLastCalledWith('connected');
        });

        it('refuses a second connect while one is in flight, then accepts the next', async () => {
            let release: () => void = () => undefined;
            probe.mockImplementationOnce(() => new Promise(resolve => {
                release = () => resolve({ stdout: '', stderr: '' });
            }));
            setAvailable('node', 'openclaw');

            const first = connect();
            await connect();
            expect(infoMessage).toHaveBeenCalledWith('OpenClaw connection is already in progress.');
            expect(terminals.openclaw.sendText).not.toHaveBeenCalled();

            release();
            await first;
            expect(terminals.openclaw.sendText).toHaveBeenCalledTimes(1);

            await connect();
            expect(terminals.openclaw.sendText).toHaveBeenCalledTimes(2);
        });

        it('stops with the Node.js prompt when node is missing', async () => {
            setAvailable('openclaw');

            await connect();

            expect(setStatus).toHaveBeenLastCalledWith('idle');
            expect(errorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Node.js is required'),
                'Install Node.js',
                'More options...'
            );
            expect(terminals.openclaw.sendText).not.toHaveBeenCalled();
        });

        it('offers to install when the CLI is missing and no legacy CLI exists', async () => {
            setAvailable('node');

            await connect();

            expect(setStatus).toHaveBeenLastCalledWith('idle');
            expect(probed()).toEqual(['node', 'openclaw', 'molt', 'molt.exe', 'clawdbot', 'clawdbot.exe']);
            expect(errorMessage).toHaveBeenCalledWith(
                'Command not found: openclaw. Install OpenClaw or update OpenClaw: Command in settings.',
                'Install CLI',
                'More options...'
            );
            expect(terminals.openclaw.sendText).not.toHaveBeenCalled();
        });

        it('starts the install flow from the missing-CLI prompt', async () => {
            setAvailable('node');
            answerButtons(errorMessage, 'Install CLI');
            answerPicks(undefined);

            await connect();

            expect(quickPick).toHaveBeenCalledWith(expect.any(Array), { placeHolder: 'Select an install method for the OpenClaw CLI' });
        });

        it.each([
            ['Copy install command', () => copyInstallCommand],
            ['Open docs', () => openDocs],
            ['Open settings', () => openSettings],
        ] as const)('runs "%s" from the missing-CLI more options', async (label, target) => {
            setAvailable('node');
            answerButtons(errorMessage, 'More options...');
            answerPicks(label);

            await connect();

            expect(pickLabels(0)).toEqual(['Copy install command', 'Open docs', 'Open settings']);
            expect(target()).toHaveBeenCalledTimes(1);
        });

        it('does nothing when the missing-CLI more options are dismissed', async () => {
            setAvailable('node');
            answerButtons(errorMessage, 'More options...');
            answerPicks(undefined);

            await connect();

            expect(copyInstallCommand).not.toHaveBeenCalled();
            expect(openDocs).not.toHaveBeenCalled();
            expect(openSettings).not.toHaveBeenCalled();
        });

        it('points at the legacy CLI found on the PATH instead of the generic install prompt', async () => {
            setAvailable('node', 'clawdbot');

            await connect();

            expect(errorMessage).toHaveBeenCalledWith(
                'Found legacy CLI "clawdbot". OpenClaw is the new name. Update to OpenClaw to continue.',
                'Install OpenClaw',
                'More options...'
            );
            expect(errorMessage).toHaveBeenCalledTimes(1);
        });

        it('starts the install flow from the legacy-CLI prompt', async () => {
            setAvailable('node', 'molt');
            answerButtons(errorMessage, 'Install OpenClaw');
            answerPicks(undefined);

            await connect();

            expect(quickPick).toHaveBeenCalledTimes(1);
            expect(pickLabels(0)).toContain('Install via shell script (recommended)');
        });

        it.each([
            ['Open update docs', () => expect(openUpdateDocs).toHaveBeenCalledTimes(1)],
            ['Copy installer command', () => expect(copyToClipboard).toHaveBeenCalledWith(OPENCLAW_INSTALL_SCRIPT, 'Installer command copied to clipboard.')],
            ['Copy npm update command', () => expect(copyToClipboard).toHaveBeenCalledWith(OPENCLAW_NPM_INSTALL, 'npm update command copied to clipboard.')],
            ['Open settings', () => expect(openSettings).toHaveBeenCalledTimes(1)],
        ] as const)('runs "%s" from the legacy-CLI more options', async (label, verify) => {
            setAvailable('node', 'clawdbot.exe');
            answerButtons(errorMessage, 'More options...');
            answerPicks(label);

            await connect();

            expect(pickLabels(0)).toEqual(['Open update docs', 'Copy installer command', 'Copy npm update command', 'Open settings']);
            verify();
        });

        it('does nothing when the legacy more options are dismissed', async () => {
            setAvailable('node', 'clawdbot');
            answerButtons(errorMessage, 'More options...');
            answerPicks(undefined);

            await connect();

            expect(openUpdateDocs).not.toHaveBeenCalled();
            expect(copyToClipboard).not.toHaveBeenCalled();
            expect(openSettings).not.toHaveBeenCalled();
        });

        describe('with a legacy command configured', () => {
            it('migrates the setting to openclaw and connects with the rewritten command', async () => {
                const update = useCommandSetting('clawdbot status --deep');
                setAvailable('node', 'openclaw');
                answerButtons(warningMessage, 'Use openclaw');

                await connect();

                expect(warningMessage).toHaveBeenCalledWith(
                    'This command uses legacy "clawdbot". OpenClaw is the new name. Update to OpenClaw for safe migrations.',
                    'Use openclaw',
                    'More options...'
                );
                expect(update).toHaveBeenCalledWith('command', 'openclaw status --deep', vscode.ConfigurationTarget.Global);
                expect(infoMessage).toHaveBeenCalledWith('Updated OpenClaw: Command setting.');
                expect(terminals.openclaw.sendText).toHaveBeenCalledWith('openclaw status --deep');
                expect(setStatus).toHaveBeenLastCalledWith('connected');
            });

            it('offers to install OpenClaw when it is not on the PATH, and does not connect', async () => {
                const update = useCommandSetting('molt status');
                setAvailable('node');
                answerButtons(warningMessage, 'Install OpenClaw');
                answerPicks(undefined);

                await connect();

                expect(buttonsOf(warningMessage, 0)).toEqual(['Install OpenClaw', 'More options...']);
                expect(quickPick).toHaveBeenCalledTimes(1);
                expect(update).not.toHaveBeenCalled();
                expect(setStatus).toHaveBeenLastCalledWith('idle');
                expect(terminals.openclaw.sendText).not.toHaveBeenCalled();
            });

            it('opens the legacy more options and does not connect', async () => {
                useCommandSetting('molt status');
                setAvailable('node', 'openclaw');
                answerButtons(warningMessage, 'More options...');
                answerPicks('Open update docs');

                await connect();

                expect(openUpdateDocs).toHaveBeenCalledTimes(1);
                expect(setStatus).toHaveBeenLastCalledWith('idle');
                expect(terminals.openclaw.sendText).not.toHaveBeenCalled();
            });

            it('leaves the setting alone and stays idle when the warning is dismissed', async () => {
                const update = useCommandSetting('molt status');
                setAvailable('node', 'openclaw');

                await connect();

                expect(update).not.toHaveBeenCalled();
                expect(setStatus).toHaveBeenLastCalledWith('idle');
                expect(terminals.openclaw.sendText).not.toHaveBeenCalled();
            });
        });

        it('reports a failure with secrets redacted and resets the in-flight guard', async () => {
            setAvailable('node', 'openclaw');
            terminals.openclaw.show.mockImplementationOnce(() => {
                throw new Error('spawn failed: token=abc123');
            });

            await connect();

            expect(setStatus).toHaveBeenLastCalledWith('error');
            expect(errorMessage).toHaveBeenCalledWith('Failed to connect: spawn failed: token=***');

            await connect();
            expect(setStatus).toHaveBeenLastCalledWith('connected');
        });
    });

    describe('connect on win32', () => {
        usePlatform('win32');

        it('probes with where.exe under C:\\Windows when SystemRoot is unset, then sends the default command', async () => {
            setAvailable('node', 'openclaw');
            const env = replaceEnv({});
            try {
                await connect();
            } finally {
                env.restore();
            }

            expect(probe).toHaveBeenCalledWith('C:\\Windows\\System32\\where.exe', ['node']);
            expect(probe).toHaveBeenCalledWith('C:\\Windows\\System32\\where.exe', ['openclaw']);
            expect(terminals.openclaw.sendText).toHaveBeenCalledWith('openclaw status');
        });
    });

    describe('runSetupFlow', () => {
        describe('on linux', () => {
            usePlatform('linux');

            it('does nothing when the install picker is dismissed', async () => {
                answerPicks(undefined);

                await runSetupFlow();

                expect(warningMessage).not.toHaveBeenCalled();
                expect(terminals.setup.sendText).not.toHaveBeenCalled();
            });

            it('runs the shell installer in the setup terminal after confirmation', async () => {
                answerPicks('Install via shell script (recommended)');
                answerButtons(warningMessage, 'Run install');

                await runSetupFlow();

                expect(pickLabels(0)).toEqual([
                    'Install via shell script (recommended)',
                    'Install Node.js (required for npm install)',
                    'Install via npm',
                    'Open installation docs',
                ]);
                expect(warningMessage).toHaveBeenCalledWith(
                    `Run this command in a terminal?\n${OPENCLAW_INSTALL_SCRIPT}`,
                    { modal: true },
                    'Run install',
                    'Copy command',
                    'Cancel'
                );
                expect(terminals.setup.show).toHaveBeenCalledWith(true);
                expect(terminals.setup.sendText).toHaveBeenCalledWith(OPENCLAW_INSTALL_SCRIPT);
                expect(probe).not.toHaveBeenCalled();
            });

            it('copies the install command instead of running it', async () => {
                answerPicks('Install via shell script (recommended)');
                answerButtons(warningMessage, 'Copy command');

                await runSetupFlow();

                expect(copyToClipboard).toHaveBeenCalledWith(OPENCLAW_INSTALL_SCRIPT, 'Install command copied to clipboard.');
                expect(terminals.setup.sendText).not.toHaveBeenCalled();
            });

            it.each(['Cancel', undefined])('runs nothing when the confirmation answer is %s', async answer => {
                answerPicks('Install via shell script (recommended)');
                answerButtons(warningMessage, answer);

                await runSetupFlow();

                expect(copyToClipboard).not.toHaveBeenCalled();
                expect(terminals.setup.sendText).not.toHaveBeenCalled();
            });

            it('opens the installation docs', async () => {
                answerPicks('Open installation docs');

                await runSetupFlow();

                expect(openDocs).toHaveBeenCalledTimes(1);
                expect(warningMessage).not.toHaveBeenCalled();
            });

            it('hands over to the Node.js install flow', async () => {
                answerPicks('Install Node.js (required for npm install)', undefined);

                await runSetupFlow();

                expect(quickPick).toHaveBeenLastCalledWith(expect.any(Array), {
                    placeHolder: 'Install Node.js (Node 24 recommended, 22.16+ supported)',
                });
            });

            it('runs the npm install when node is present', async () => {
                setAvailable('node');
                answerPicks('Install via npm');
                answerButtons(warningMessage, 'Run install');

                await runSetupFlow();

                expect(probed()).toEqual(['node']);
                expect(terminals.setup.sendText).toHaveBeenCalledWith(OPENCLAW_NPM_INSTALL);
            });

            it('asks for Node.js instead of running npm when node is missing', async () => {
                setAvailable();
                answerPicks('Install via npm');

                await runSetupFlow();

                expect(errorMessage).toHaveBeenCalledWith(expect.stringContaining('Node.js is required'), 'Install Node.js', 'More options...');
                expect(warningMessage).not.toHaveBeenCalled();
            });

            it('ignores an option that carries neither an action nor a command', async () => {
                vi.mocked(getInstallOptions).mockReturnValueOnce([{ label: 'Broken' }]);
                answerPicks('Broken');

                await runSetupFlow();

                expect(openDocs).not.toHaveBeenCalled();
                expect(warningMessage).not.toHaveBeenCalled();
            });
        });

        describe('on win32', () => {
            usePlatform('win32');

            it('offers and runs the PowerShell installer', async () => {
                answerPicks('Install via PowerShell script (recommended)');
                answerButtons(warningMessage, 'Run install');

                await runSetupFlow();

                expect(pickLabels(0)).not.toContain('Install via shell script (recommended)');
                expect(terminals.setup.sendText).toHaveBeenCalledWith(OPENCLAW_INSTALL_PS1);
            });
        });
    });

    describe('runNodeSetupFlow', () => {
        describe.each([
            ['linux', 'Install Node.js (LTS) via apt', LINUX_NODE],
            ['darwin', 'Install Node.js (LTS) via Homebrew', 'brew install node'],
            ['win32', 'Install Node.js (LTS) via winget', 'winget install OpenJS.NodeJS.LTS'],
        ] as const)('on %s', (platform, label, command) => {
            usePlatform(platform);

            it('runs the platform installer after confirmation', async () => {
                answerPicks(label);
                answerButtons(warningMessage, 'Run install');

                await runNodeSetupFlow();

                expect(pickLabels(0)).toEqual([label, 'Open Node.js download page']);
                expect(terminals.setup.sendText).toHaveBeenCalledWith(command);
            });
        });

        describe('on linux', () => {
            usePlatform('linux');

            it('opens the Node.js download page', async () => {
                answerPicks('Open Node.js download page');

                await runNodeSetupFlow();

                expect(openNodeDocs).toHaveBeenCalledTimes(1);
                expect(warningMessage).not.toHaveBeenCalled();
            });

            it('does nothing when dismissed', async () => {
                answerPicks(undefined);

                await runNodeSetupFlow();

                expect(openNodeDocs).not.toHaveBeenCalled();
                expect(warningMessage).not.toHaveBeenCalled();
            });

            it('ignores an option without a command', async () => {
                vi.mocked(getNodeInstallOptions).mockReturnValueOnce([{ label: 'Broken' }]);
                answerPicks('Broken');

                await runNodeSetupFlow();

                expect(openNodeDocs).not.toHaveBeenCalled();
                expect(warningMessage).not.toHaveBeenCalled();
            });
        });
    });

    describe('showMissingNodeMessage', () => {
        describe.each([
            ['linux', LINUX_NODE],
            ['darwin', 'brew install node'],
            ['win32', 'winget install OpenJS.NodeJS.LTS'],
        ] as const)('on %s', (platform, command) => {
            usePlatform(platform);

            it('copies the platform Node.js install command', async () => {
                answerButtons(errorMessage, 'More options...');
                answerPicks('Copy Node.js install command');

                await showMissingNodeMessage();

                expect(pickLabels(0)).toEqual(['Copy Node.js install command', 'Open Node.js download page']);
                expect(copyToClipboard).toHaveBeenCalledWith(command, 'Node.js install command copied to clipboard.');
            });
        });

        describe('on linux', () => {
            usePlatform('linux');

            it('starts the Node.js install flow', async () => {
                answerButtons(errorMessage, 'Install Node.js');
                answerPicks(undefined);

                await showMissingNodeMessage();

                expect(errorMessage).toHaveBeenCalledWith(
                    'Node.js is required to run the OpenClaw CLI. Node 24 recommended (Node 22.16+ also supported).',
                    'Install Node.js',
                    'More options...'
                );
                expect(pickLabels(0)).toEqual(['Install Node.js (LTS) via apt', 'Open Node.js download page']);
            });

            it('opens the download page from more options', async () => {
                answerButtons(errorMessage, 'More options...');
                answerPicks('Open Node.js download page');

                await showMissingNodeMessage();

                expect(openNodeDocs).toHaveBeenCalledTimes(1);
                expect(copyToClipboard).not.toHaveBeenCalled();
            });

            it('does nothing when more options are dismissed', async () => {
                answerButtons(errorMessage, 'More options...');
                answerPicks(undefined);

                await showMissingNodeMessage();

                expect(openNodeDocs).not.toHaveBeenCalled();
                expect(copyToClipboard).not.toHaveBeenCalled();
            });

            it('does nothing when the prompt is dismissed', async () => {
                await showMissingNodeMessage();

                expect(quickPick).not.toHaveBeenCalled();
            });

            it('offers only the download page when there is no install command for the platform', async () => {
                vi.mocked(getNodeInstallCommandForPlatform).mockReturnValueOnce(undefined);
                answerButtons(errorMessage, 'More options...');
                answerPicks('Open Node.js download page');

                await showMissingNodeMessage();

                expect(pickLabels(0)).toEqual(['Open Node.js download page']);
                expect(openNodeDocs).toHaveBeenCalledTimes(1);
            });
        });
    });

    describe('runCliInTerminal', () => {
        usePlatform('linux');

        it('sends a non-OpenClaw command without probing', async () => {
            await runCliInTerminal('git status', 'Running git.');

            expect(probe).not.toHaveBeenCalled();
            expect(terminals.openclaw.show).toHaveBeenCalledWith(true);
            expect(terminals.openclaw.sendText).toHaveBeenCalledWith('git status');
            expect(infoMessage).toHaveBeenCalledWith('Running git.');
        });

        it('sends an OpenClaw command once node and the CLI are found', async () => {
            setAvailable('node', 'openclaw');

            await runCliInTerminal('openclaw doctor', 'Running doctor.');

            expect(probed()).toEqual(['node', 'openclaw']);
            expect(terminals.openclaw.sendText).toHaveBeenCalledWith('openclaw doctor');
            expect(infoMessage).toHaveBeenCalledWith('Running doctor.');
        });

        it('asks for Node.js when node is missing', async () => {
            setAvailable('openclaw');

            await runCliInTerminal('openclaw doctor', 'Running doctor.');

            expect(errorMessage).toHaveBeenCalledWith(expect.stringContaining('Node.js is required'), 'Install Node.js', 'More options...');
            expect(terminals.openclaw.sendText).not.toHaveBeenCalled();
        });

        it('offers only the install action when the CLI is missing', async () => {
            setAvailable('node');
            answerButtons(errorMessage, 'Install CLI');
            answerPicks(undefined);

            await runCliInTerminal('openclaw.exe doctor', 'Running doctor.');

            expect(errorMessage).toHaveBeenCalledWith('Command not found: openclaw.exe. Install OpenClaw first.', 'Install CLI');
            expect(quickPick).toHaveBeenCalledTimes(1);
            expect(terminals.openclaw.sendText).not.toHaveBeenCalled();
        });
    });

    describe('updateOpenClawCommandSetting', () => {
        it('writes the command to the global setting and confirms', async () => {
            const update = useCommandSetting('openclaw status');

            await updateOpenClawCommandSetting('openclaw gateway status');

            expect(getConfiguration).toHaveBeenCalledWith('openclaw');
            expect(update).toHaveBeenCalledWith('command', 'openclaw gateway status', vscode.ConfigurationTarget.Global);
            expect(infoMessage).toHaveBeenCalledWith('Updated OpenClaw: Command setting.');
        });
    });

    describe('runModelSetupWizard', () => {
        usePlatform('linux');

        const ONBOARDING = ['Run onboarding wizard (recommended)', 'Run onboarding without daemon', 'Open onboarding docs', 'Skip onboarding for now'];
        const PROVIDERS = ['OpenAI', 'Anthropic', 'Google (Gemini)', 'Ollama (local models)', 'Local Pi RPC (default)', 'Other / Custom provider'];

        beforeEach(() => {
            setAvailable('node', 'openclaw');
        });

        it('offers install with a cancel button when the CLI is missing', async () => {
            setAvailable('node');
            answerButtons(errorMessage, 'Cancel');

            await runModelSetupWizard();

            expect(errorMessage).toHaveBeenCalledWith(
                'OpenClaw CLI not found. Install it to run the Model Setup Wizard.',
                'Install CLI',
                'More options...',
                'Cancel'
            );
            expect(quickPick).not.toHaveBeenCalled();
        });

        it('asks for Node.js when node is missing', async () => {
            setAvailable('openclaw');

            await runModelSetupWizard();

            expect(errorMessage).toHaveBeenCalledWith(expect.stringContaining('Node.js is required'), 'Install Node.js', 'More options...');
            expect(quickPick).not.toHaveBeenCalled();
        });

        it('stops when onboarding is dismissed', async () => {
            answerPicks(undefined);

            await runModelSetupWizard();

            expect(pickLabels(0)).toEqual(ONBOARDING);
            expect(quickPick).toHaveBeenCalledTimes(1);
        });

        it('opens the onboarding docs and stops', async () => {
            answerPicks('Open onboarding docs');

            await runModelSetupWizard();

            expect(openOnboardDocs).toHaveBeenCalledTimes(1);
            expect(quickPick).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['Run onboarding wizard (recommended)', 'openclaw onboard --install-daemon'],
            ['Run onboarding without daemon', 'openclaw onboard'],
        ])('runs "%s" and stops unless the user continues', async (label, command) => {
            answerPicks(label);

            await runModelSetupWizard();

            expect(terminals.setup.show).toHaveBeenCalledWith(true);
            expect(terminals.setup.sendText).toHaveBeenCalledWith(command);
            expect(infoMessage).toHaveBeenCalledWith('Complete the OpenClaw onboarding in the terminal, then continue.', 'Continue');
            expect(quickPick).toHaveBeenCalledTimes(1);
        });

        it('continues to provider selection after onboarding', async () => {
            answerPicks('Run onboarding wizard (recommended)', undefined);
            answerButtons(infoMessage, 'Continue');

            await runModelSetupWizard();

            expect(pickLabels(1)).toEqual(PROVIDERS);
            expect(quickPick).toHaveBeenCalledTimes(2);
        });

        it('skips onboarding straight to provider selection and stops when it is dismissed', async () => {
            answerPicks('Skip onboarding for now', undefined);

            await runModelSetupWizard();

            expect(terminals.setup.sendText).not.toHaveBeenCalled();
            expect(quickPick).toHaveBeenCalledTimes(2);
        });

        it('opens the provider index for a custom provider, then offers checks', async () => {
            answerPicks('Skip onboarding for now', 'Other / Custom provider', undefined);

            await runModelSetupWizard();

            expect(openExternal).toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'https://docs.openclaw.ai/providers' }));
            expect(pickLabels(2)).toEqual(['Run doctor + status checks', 'Open dashboard', 'Skip checks for now']);
        });

        it.each([
            ['OpenAI', 'OpenAI', 'https://docs.openclaw.ai/providers/openai'],
            ['Anthropic', 'Anthropic', 'https://docs.openclaw.ai/providers/anthropic'],
            ['Google (Gemini)', 'Google (Gemini)', 'https://docs.openclaw.ai/providers/google'],
            ['Ollama (local models)', 'Ollama', 'https://docs.openclaw.ai/providers/ollama'],
            ['Local Pi RPC (default)', 'Local Pi RPC', 'https://docs.openclaw.ai/pi'],
        ])('opens the %s setup docs', async (provider, label, url) => {
            answerPicks('Skip onboarding for now', provider, `Open ${label} setup docs`, 'Skip checks for now');

            await runModelSetupWizard();

            expect(quickPick.mock.calls[2][1]).toEqual({ placeHolder: `Finish ${label} setup` });
            expect(openExternal).toHaveBeenCalledWith(expect.objectContaining({ fsPath: url }));
        });

        it('opens the config file, creating it if missing', async () => {
            answerPicks('Skip onboarding for now', 'OpenAI', 'Open OpenClaw config file', 'Skip checks for now');

            await runModelSetupWizard();

            expect(openOpenClawConfig).toHaveBeenCalledWith(true);
            expect(openExternal).not.toHaveBeenCalled();
        });

        it('opens the auth profiles', async () => {
            answerPicks('Skip onboarding for now', 'Anthropic', 'Open auth profiles', 'Skip checks for now');

            await runModelSetupWizard();

            expect(openAuthProfiles).toHaveBeenCalledTimes(1);
        });

        it.each(['Skip provider setup', undefined])('does nothing for provider action %s but still offers checks', async action => {
            answerPicks('Skip onboarding for now', 'Ollama (local models)', action, undefined);

            await runModelSetupWizard();

            expect(openExternal).not.toHaveBeenCalled();
            expect(openOpenClawConfig).not.toHaveBeenCalled();
            expect(openAuthProfiles).not.toHaveBeenCalled();
            expect(quickPick).toHaveBeenCalledTimes(4);
        });

        it('runs doctor and gateway status in the OpenClaw terminal', async () => {
            answerPicks('Skip onboarding for now', 'Other / Custom provider', 'Run doctor + status checks');

            await runModelSetupWizard();

            expect(terminals.openclaw.show).toHaveBeenCalledWith(true);
            expect(terminals.openclaw.sendText.mock.calls).toEqual([['openclaw doctor'], ['openclaw gateway status']]);
            expect(infoMessage).toHaveBeenCalledWith('Running OpenClaw doctor and gateway status checks.');
        });

        it('opens the dashboard', async () => {
            answerPicks('Skip onboarding for now', 'Other / Custom provider', 'Open dashboard');

            await runModelSetupWizard();

            expect(openDashboard).toHaveBeenCalledTimes(1);
            expect(terminals.openclaw.sendText).not.toHaveBeenCalled();
        });

        it.each(['Skip checks for now', undefined])('runs no checks for %s', async answer => {
            answerPicks('Skip onboarding for now', 'Other / Custom provider', answer);

            await runModelSetupWizard();

            expect(openDashboard).not.toHaveBeenCalled();
            expect(terminals.openclaw.sendText).not.toHaveBeenCalled();
        });
    });
});
