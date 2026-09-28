import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { readAttachments } from '../webview/viewMessaging';

// A controllable realpath wrapper: ESM module namespaces are not redefinable,
// so jest.spyOn cannot intercept fs/promises directly. The mock routes
// realpath through a swappable implementation the swap test can replace.
let realpathImpl: (p: fs.PathLike) => Promise<string> = (p) => fsp.realpath(p as string);
jest.mock('fs/promises', () => {
    const actual = jest.requireActual('fs/promises');
    return {
        ...actual,
        realpath: (p: fs.PathLike) => (globalThis as any).__realpathImpl(p),
    };
});
beforeEach(() => {
    (globalThis as any).__realpathImpl = (p: fs.PathLike) => realpathImpl(p);
});
afterEach(() => {
    (globalThis as any).__realpathImpl = undefined;
    realpathImpl = (p) => fsp.realpath(p as string);
});

describe('readAttachments FIFO rejection', () => {
    const posixOnly = process.platform === 'win32' ? it.skip : it;
    const isWindows = process.platform === 'win32';
    let dir: string;
    let fifoPath: string;

    beforeEach(() => {
        if (isWindows) {
            return;
        }
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-fifo-'));
        fifoPath = path.join(dir, 'pipe');
        execFileSync('mkfifo', [fifoPath]);
    });

    afterEach(() => {
        if (isWindows) {
            return;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    posixOnly('rejects a text attachment FIFO instead of blocking the open', async () => {
        const { prompt } = await readAttachments([{ name: 'pipe', path: fifoPath, type: 'file' }]);
        expect(prompt).toContain('[Could not read file]');
        expect(prompt).not.toMatch(/openclaw-fifo-[^/\s"]*pipe"[^>]*>[\s\S]*regular file/i);
    });

    posixOnly('rejects an image attachment FIFO instead of blocking the open', async () => {
        const { prompt } = await readAttachments([{ name: 'pipe', path: fifoPath, type: 'image' }]);
        expect(prompt).toContain('[Could not read file]');
        expect(prompt).not.toContain('<image');
    });
});
describe('readAttachments text budget', () => {
    const posixOnly = process.platform === 'win32' ? it.skip : it;

    posixOnly('caps text attachments at the CLI argument budget for tempFile mode', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-text-'));
        try {
            const big = path.join(dir, 'big.txt');
            fs.writeFileSync(big, 'a'.repeat(80 * 1024));
            const { prompt } = await readAttachments(
                [{ name: 'big.txt', path: big, type: 'file' }],
                { imageMode: 'tempFile' }
            );
            expect(prompt).toContain('[Could not read file]');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    posixOnly('does not charge the aggregate budget when the final realpath validation fails', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-swap-'));
        try {
            const realFile = path.join(dir, 'real.txt');
            fs.writeFileSync(realFile, 'hello');
            // The input is canonical, so the pre-open realpath passes. The
            // post-read re-canonicalization is mocked to observe a swapped
            // path (a swap racing between read and final validation on a
            // case-sensitive volume): the swap must be detected there and
            // the budget left untouched so the second attachment fits.
            const other = path.join(dir, 'other.txt');
            fs.writeFileSync(other, 'b'.repeat(4 * 1024));
            const swapPath = path.join(dir, 'swapped.txt');
            let reads = 0;
            realpathImpl = async (p: fs.PathLike) => {
                const resolved = fs.realpathSync(p as string);
                // The second canonicalization (after the read) sees the swap.
                if (resolved === realFile && ++reads > 1) {
                    return swapPath;
                }
                return resolved;
            };
            const { prompt } = await readAttachments(
                [
                    { name: 'real.txt', path: realFile, type: 'file' },
                    { name: 'other.txt', path: other, type: 'file' },
                ],
                { reservedPromptBytes: 20 * 1024 * 1024 - 5 * 1024 }
            );
            // The swapped attachment is dropped without consuming budget, so
            // the second one is still emitted.
            expect(prompt).toContain('real.txt');
            expect(prompt).toContain('other.txt');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
