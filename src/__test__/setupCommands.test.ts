jest.mock('../vscode/commands/shared', () => ({ log: jest.fn(), execFileAsync: jest.fn() }));

import { execFileAsync } from '../vscode/commands/shared';
import { isCommandAvailable } from '../vscode/commands/setup';

async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
        return await run();
    } finally {
        Object.defineProperty(process, 'platform', original);
    }
}

describe('setup commands', () => {
    describe('isCommandAvailable', () => {
        beforeEach(() => jest.mocked(execFileAsync).mockReset().mockResolvedValue({ stdout: '', stderr: '' } as never));

        it('probes through /bin/sh, never a sh found on PATH', async () => {
            await expect(onPlatform('linux', () => isCommandAvailable('node'))).resolves.toBe(true);
            expect(execFileAsync).toHaveBeenCalledWith('/bin/sh', ['-c', 'command -v "$1"', 'sh', 'node']);
        });

        it('probes through the system where.exe, as a bare where is looked up in the cwd first', async () => {
            const env = jest.replaceProperty(process, 'env', { SystemRoot: 'D:\\Win' });
            try {
                await onPlatform('win32', () => isCommandAvailable('node'));
            } finally {
                env.restore();
            }
            expect(execFileAsync).toHaveBeenCalledWith('D:\\Win\\System32\\where.exe', ['node']);
        });

        it('reports a command the probe cannot find as missing', async () => {
            jest.mocked(execFileAsync).mockRejectedValue(new Error('not found'));
            await expect(onPlatform('linux', () => isCommandAvailable('nope'))).resolves.toBe(false);
        });
    });
});
