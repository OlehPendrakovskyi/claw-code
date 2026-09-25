const mockPlatform = { current: 'linux' as NodeJS.Platform };

jest.mock('os', () => {
    const actual = jest.requireActual('os');
    return {
        ...actual,
        platform: () => mockPlatform.current
    };
});

import {
    LEGACY_CLI_ALIASES,
    OPENCLAW_INSTALL_PS1,
    OPENCLAW_INSTALL_SCRIPT,
    OPENCLAW_NPM_INSTALL,
    getInstallOptions,
    getLegacyExecutable,
    getNodeInstallCommandForPlatform,
    getNodeInstallOptions,
    replaceExecutable
} from '../core/setupOptions';

type Platform = NodeJS.Platform;

const withPlatform = (platform: Platform, fn: () => void) => {
    // os.platform() is not configurable in Node 24; drive it through a jest module mock.
    const previous = mockPlatform.current;
    mockPlatform.current = platform;
    try {
        fn();
    } finally {
        mockPlatform.current = previous;
    }
};

describe('install command constants', () => {
    it('exposes the documented installers', () => {
        expect(OPENCLAW_INSTALL_SCRIPT).toBe('curl -fsSL https://openclaw.ai/install.sh | bash');
        expect(OPENCLAW_INSTALL_PS1).toBe('iwr -useb https://openclaw.ai/install.ps1 | iex');
        expect(OPENCLAW_NPM_INSTALL).toBe('npm install -g openclaw@latest');
    });
});

describe('LEGACY_CLI_ALIASES', () => {
    it('contains the four legacy executable names', () => {
        expect([...LEGACY_CLI_ALIASES].sort()).toEqual(['clawdbot', 'clawdbot.exe', 'molt', 'molt.exe']);
    });

    it('does not contain the current executable name', () => {
        expect(LEGACY_CLI_ALIASES.has('openclaw')).toBe(false);
    });
});

describe('getInstallOptions', () => {
    it('offers the shell script on Linux', () => {
        withPlatform('linux', () => {
            const [first] = getInstallOptions();
            expect(first.command).toBe(OPENCLAW_INSTALL_SCRIPT);
        });
    });

    it('offers the PowerShell script on Windows', () => {
        withPlatform('win32', () => {
            const [first] = getInstallOptions();
            expect(first.command).toBe(OPENCLAW_INSTALL_PS1);
        });
    });

    it('always offers Node setup, npm install and docs', () => {
        const options = getInstallOptions();
        expect(options).toHaveLength(4);
        const actions = options.map(o => o.action);
        expect(actions).toContain('node');
        expect(actions).toContain('docs');
        expect(options.filter(o => o.command === OPENCLAW_NPM_INSTALL)).toHaveLength(1);
    });

    it('labels Node setup per platform', () => {
        withPlatform('win32', () => {
            const nodeOption = getInstallOptions().find(o => o.action === 'node');
            expect(nodeOption?.description).toBe('Windows: recommended via winget');
        });
        withPlatform('linux', () => {
            const nodeOption = getInstallOptions().find(o => o.action === 'node');
            expect(nodeOption?.description).toBe('macOS/Linux: install Node.js first');
        });
    });
});

describe('getNodeInstallOptions', () => {
    it('uses winget on Windows', () => {
        withPlatform('win32', () => {
            const options = getNodeInstallOptions();
            expect(options).toHaveLength(2);
            expect(options[0].command).toBe('winget install OpenJS.NodeJS.LTS');
            expect(options[1].action).toBe('nodeDocs');
        });
    });

    it('uses Homebrew on macOS', () => {
        withPlatform('darwin', () => {
            const options = getNodeInstallOptions();
            expect(options[0].command).toBe('brew install node');
        });
    });

    it('uses apt/Nodesource on Linux', () => {
        withPlatform('linux', () => {
            const options = getNodeInstallOptions();
            expect(options[0].command).toContain('deb.nodesource.com');
        });
    });
});

describe('getNodeInstallCommandForPlatform', () => {
    it('mirrors getNodeInstallOptions for Windows', () => {
        withPlatform('win32', () => {
            expect(getNodeInstallCommandForPlatform()).toBe('winget install OpenJS.NodeJS.LTS');
        });
    });

    it('mirrors getNodeInstallOptions for macOS', () => {
        withPlatform('darwin', () => {
            expect(getNodeInstallCommandForPlatform()).toBe('brew install node');
        });
    });

    it('mirrors getNodeInstallOptions for Linux', () => {
        withPlatform('linux', () => {
            expect(getNodeInstallCommandForPlatform()).toContain('deb.nodesource.com');
        });
    });
});

describe('getLegacyExecutable', () => {
    it('returns known legacy executables unchanged', () => {
        for (const legacy of ['molt', 'molt.exe', 'clawdbot', 'clawdbot.exe']) {
            expect(getLegacyExecutable(legacy)).toBe(legacy);
        }
    });

    it('is case-insensitive but preserves the original spelling', () => {
        expect(getLegacyExecutable('MOLT')).toBe('MOLT');
    });

    it('returns undefined for anything else', () => {
        expect(getLegacyExecutable('openclaw')).toBeUndefined();
        expect(getLegacyExecutable('node')).toBeUndefined();
    });
});

describe('replaceExecutable', () => {
    it('replaces only the first token', () => {
        expect(replaceExecutable('molt status --all', 'openclaw')).toBe('openclaw status --all');
    });

    it('normalises surrounding whitespace', () => {
        expect(replaceExecutable('  molt   status  ', 'openclaw')).toBe('openclaw status');
    });

    it('leaves a bare executable alone apart from the swap', () => {
        expect(replaceExecutable('molt', 'openclaw')).toBe('openclaw');
    });
});
