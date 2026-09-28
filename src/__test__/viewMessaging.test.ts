import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readAttachments } from '../webview/viewMessaging';

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
            // Alias that resolves to the same file now but is swapped to a
            // different canonical path after the read begins: the budget
            // must stay untouched so the second attachment still fits.
            const symlink = path.join(dir, 'link.txt');
            fs.symlinkSync(realFile, symlink);
            const other = path.join(dir, 'other.txt');
            fs.writeFileSync(other, 'b'.repeat(4 * 1024));
            const { prompt } = await readAttachments(
                [
                    { name: 'link.txt', path: symlink, type: 'file' },
                    { name: 'other.txt', path: other, type: 'file' },
                ],
                { reservedPromptBytes: 20 * 1024 * 1024 - 5 * 1024 }
            );
            // The swapped attachment is dropped without consuming budget, so
            // the second one is still emitted (symlink swap is detected after
            // the read on case-sensitive volumes).
            expect(prompt).toContain('link.txt');
            expect(prompt).toContain('other.txt');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
