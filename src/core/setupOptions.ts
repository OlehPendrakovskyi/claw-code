import * as os from 'os';

export const OPENCLAW_INSTALL_SCRIPT = 'curl -fsSL https://openclaw.ai/install.sh | bash';

export const OPENCLAW_INSTALL_PS1 = 'iwr -useb https://openclaw.ai/install.ps1 | iex';

export const OPENCLAW_NPM_INSTALL = 'npm install -g openclaw@latest';

export const LEGACY_CLI_ALIASES = new Set(['molt', 'molt.exe', 'clawdbot', 'clawdbot.exe']);

export function getInstallOptions(): Array<{
    label: string;
    description?: string;
    detail?: string;
    command?: string;
    action?: 'docs' | 'node' | 'nodeDocs';
}> {
    const platform = os.platform();
    const isWindows = platform === 'win32';
    const npmCommand = OPENCLAW_NPM_INSTALL;

    const options: Array<{
        label: string;
        description?: string;
        detail?: string;
        command?: string;
        action?: 'docs' | 'node' | 'nodeDocs';
    }> = [];

    if (isWindows) {
        options.push({
            label: 'Install via PowerShell script (recommended)',
            description: 'Detects OS, installs Node if needed, launches onboarding',
            detail: OPENCLAW_INSTALL_PS1,
            command: OPENCLAW_INSTALL_PS1
        });
    } else {
        options.push({
            label: 'Install via shell script (recommended)',
            description: 'Detects OS, installs Node if needed, launches onboarding',
            detail: OPENCLAW_INSTALL_SCRIPT,
            command: OPENCLAW_INSTALL_SCRIPT
        });
    }

    options.push(
        {
            label: 'Install Node.js (required for npm install)',
            description: isWindows ? 'Windows: recommended via winget' : 'macOS/Linux: install Node.js first',
            action: 'node'
        },
        {
            label: 'Install via npm',
            description: isWindows ? 'Works on Windows with Node.js' : 'Works on macOS and Linux with Node.js',
            detail: npmCommand,
            command: npmCommand
        },
        {
            label: 'Open installation docs',
            description: 'View all install options',
            action: 'docs'
        }
    );

    return options;
}

export function getNodeInstallOptions(): Array<{
    label: string;
    description?: string;
    detail?: string;
    command?: string;
    action?: 'nodeDocs';
}> {
    const platform = os.platform();
    const isWindows = platform === 'win32';
    const isMac = platform === 'darwin';

    if (isWindows) {
        const command = 'winget install OpenJS.NodeJS.LTS';
        return [
            {
                label: 'Install Node.js (LTS) via winget',
                description: 'Windows',
                detail: command,
                command
            },
            {
                label: 'Open Node.js download page',
                description: 'Manual installer for Windows/macOS/Linux',
                action: 'nodeDocs'
            }
        ];
    }

    if (isMac) {
        const command = 'brew install node';
        return [
            {
                label: 'Install Node.js (LTS) via Homebrew',
                description: 'macOS (requires Homebrew)',
                detail: command,
                command
            },
            {
                label: 'Open Node.js download page',
                description: 'Manual installer for macOS/Linux',
                action: 'nodeDocs'
            }
        ];
    }

    const command = 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs';
    return [
        {
            label: 'Install Node.js (LTS) via apt',
            description: 'Ubuntu/Debian',
            detail: command,
            command
        },
        {
            label: 'Open Node.js download page',
            description: 'Manual installer for Linux',
            action: 'nodeDocs'
        }
    ];
}

export function getNodeInstallCommandForPlatform(): string | undefined {
    const platform = os.platform();
    if (platform === 'win32') {
        return 'winget install OpenJS.NodeJS.LTS';
    }
    if (platform === 'darwin') {
        return 'brew install node';
    }
    return 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs';
}

export function getLegacyExecutable(executable: string): string | undefined {
    const normalized = executable.toLowerCase();
    return LEGACY_CLI_ALIASES.has(normalized) ? executable : undefined;
}

export function replaceExecutable(command: string, newExecutable: string): string {
    const parts = command.trim().split(/\s+/);
    if (parts.length === 0) {
        return command;
    }
    parts[0] = newExecutable;
    return parts.join(' ');
}
