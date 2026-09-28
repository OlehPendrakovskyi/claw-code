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