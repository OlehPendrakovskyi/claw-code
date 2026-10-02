// The factory must cover the whole export surface of the mocked module, not only
// the members this test calls: `setup.ts` imports `copyToClipboard` and
// `isOpenClawExecutable` from here too, and Vitest throws `No "x" export is defined`
// the moment any code path reads one (rule 50). `satisfies` keeps the completeness
// check honest; the casts are needed because two exports are an output channel and
// a type-predicate function, neither of which `vi.fn()` can infer.
vi.mock('../vscode/commands/shared', () => ({
    log: vi.fn() as unknown as typeof import('../vscode/commands/shared').log,
    execFileAsync: vi.fn() as unknown as typeof import('../vscode/commands/shared').execFileAsync,
    copyToClipboard: vi.fn() as unknown as typeof import('../vscode/commands/shared').copyToClipboard,
    isOpenClawExecutable: vi.fn(() => true) as unknown as typeof import('../vscode/commands/shared').isOpenClawExecutable,
} satisfies typeof import('../vscode/commands/shared')));

import { replaceEnv } from './helpers/env';

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
        // Braced on purpose: Vitest runs a function returned from beforeEach as the
        // test's teardown, and mockResolvedValue returns the mock itself.
        beforeEach(() => {
            vi.mocked(execFileAsync).mockReset().mockResolvedValue({ stdout: '', stderr: '' } as never);
        });

        it('probes through /bin/sh, never a sh found on PATH', async () => {
            await expect(onPlatform('linux', () => isCommandAvailable('node'))).resolves.toBe(true);
            expect(execFileAsync).toHaveBeenCalledWith('/bin/sh', ['-c', 'command -v "$1"', 'sh', 'node']);
        });

        it('probes through the system where.exe, as a bare where is looked up in the cwd first', async () => {
            const env = replaceEnv({ SystemRoot: 'D:\\Win' });
            try {
                await onPlatform('win32', () => isCommandAvailable('node'));
            } finally {
                env.restore();
            }
            expect(execFileAsync).toHaveBeenCalledWith('D:\\Win\\System32\\where.exe', ['node']);
        });

        it('reports a command the probe cannot find as missing', async () => {
            vi.mocked(execFileAsync).mockRejectedValue(new Error('not found'));
            await expect(onPlatform('linux', () => isCommandAvailable('nope'))).resolves.toBe(false);
        });
    });
});
