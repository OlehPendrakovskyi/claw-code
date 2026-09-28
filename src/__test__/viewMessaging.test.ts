import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as FspType from 'fs/promises';
import { stagedPromptImage } from '../chat/promptImages';
import { conversationHistory, readAttachments, AttachmentLimits } from '../webview/viewMessaging';

/** The payload readAttachments reserves beside an empty base prompt. */
const FRAMING_RESERVE_BYTES = 1024 * 1024;

/** Limits leaving exactly `bytes` of payload budget for the attachments of an empty prompt. */
function withBudget(bytes: number, caps: Partial<AttachmentLimits> = {}): AttachmentLimits {
    return { maxPayloadBytes: FRAMING_RESERVE_BYTES + bytes, attachmentMaxBytes: 10 * 1024 * 1024, attachmentMaxImageBytes: 10 * 1024 * 1024, ...caps };
}

// The unmocked promises API: the default implementation must bypass the mock
// below, whose realpath delegates through the swappable wrapper back to this
// implementation — calling the mocked `fsp.realpath` here would recurse.
const realFsp: typeof FspType = jest.requireActual('fs').promises;

// A controllable realpath wrapper. viewMessaging reads `promises` from 'fs',
// so that is the object mocked; ESM namespaces are not redefinable, which
// rules out jest.spyOn. Tests swap `realpathImpl` to simulate path races.
let realpathImpl: (p: fs.PathLike) => Promise<string> = (p) => realFsp.realpath(p as string);
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        promises: {
            ...actual.promises,
            realpath: (p: fs.PathLike) => (globalThis as any).__realpathImpl(p),
            lstat: (...args: Parameters<typeof FspType.lstat>) =>
                ((globalThis as any).__lstatImpl ?? actual.promises.lstat)(...args),
        },
    };
});
beforeEach(() => {
    (globalThis as any).__realpathImpl = (p: fs.PathLike) => realpathImpl(p);
});
afterEach(() => {
    (globalThis as any).__realpathImpl = undefined;
    (globalThis as any).__lstatImpl = undefined;
    realpathImpl = (p) => realFsp.realpath(p as string);
});

describe('viewMessaging', () => {
    describe('conversationHistory', () => {
        it('keeps user and assistant turns only', () => {
            expect(conversationHistory([
                { role: 'user', content: 'q' },
                { role: 'tool', entries: [] },
                { role: 'error', content: 'boom' },
                { role: 'assistant', content: 'a' },
            ])).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
        });

        it('keeps everything before a /compact that got no summary, minus the command', () => {
            expect(conversationHistory([
                { role: 'user', content: 'q' },
                { role: 'assistant', content: 'a' },
                { role: 'user', content: '/compact' },
                { role: 'error', content: 'failed' },
                { role: 'user', content: 'q2' },
            ])).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q2' }]);
        });

        it('starts from a /compact reply that completed, the summary first', () => {
            expect(conversationHistory([
                { role: 'user', content: 'old' },
                { role: 'assistant', content: 'old answer', completed: true },
                { role: 'user', content: '/compact' },
                { role: 'assistant', content: 'SUMMARY', completed: true },
                { role: 'user', content: 'new' },
            ])).toEqual([{ role: 'assistant', content: 'SUMMARY' }, { role: 'user', content: 'new' }]);
        });

        it('keeps the history when the /compact reply was stopped or failed', () => {
            expect(conversationHistory([
                { role: 'user', content: 'old' },
                { role: 'assistant', content: 'old answer', completed: true },
                { role: 'user', content: '/compact' },
                { role: 'assistant', content: 'Here is a summ' },
            ])).toEqual([
                { role: 'user', content: 'old' },
                { role: 'assistant', content: 'old answer' },
                { role: 'assistant', content: 'Here is a summ' },
            ]);
        });

        it('does not take a message merely starting with /compact for the command', () => {
            expect(conversationHistory([
                { role: 'user', content: '/compacted notes' },
                { role: 'assistant', content: 'a' },
            ])).toHaveLength(2);
        });
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

        posixOnly('gives text attachments the same size cap on both transports', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-text-'));
            try {
                const big = path.join(fs.realpathSync(dir), 'big.txt');
                fs.writeFileSync(big, 'a'.repeat(200 * 1024));
                for (const imageMode of ['attachment', 'contentBlock'] as const) {
                    const { prompt } = await readAttachments([{ name: 'big.txt', path: big, type: 'file' }], { imageMode });
                    expect(prompt).toContain('a'.repeat(200 * 1024));
                }
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
                let storedPathLookups = 0;
                realpathImpl = async (p: fs.PathLike) => {
                    // Only lookups of the stored path count: the fd-link lookup
                    // resolves to the same file but must not trigger the swap.
                    if (p === realFile && ++storedPathLookups > 1) {
                        return swapPath;
                    }
                    return realFsp.realpath(p as string);
                };
                const { prompt } = await readAttachments(
                    [
                        { name: 'real.txt', path: realFile, type: 'file' },
                        { name: 'other.txt', path: other, type: 'file' },
                    ],
                    { limits: withBudget(5 * 1024) }
                );
                // The swap is caught by the post-read check (the second stored-
                // path lookup), so real.txt is dropped without consuming budget
                // and other.txt still fits.
                expect(storedPathLookups).toBe(2);
                expect(prompt).not.toContain('hello');
                expect(prompt).toContain('b'.repeat(4 * 1024));
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('readAttachments fd-location check', () => {
        const posixOnly = process.platform === 'win32' ? it.skip : it;
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        let dir: string;
        let file: string;
        let image: string;

        const setPlatform = (platform: NodeJS.Platform) => {
            Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
        };

        /** Route fd-link lookups to `resolveFdLink`; every other path resolves normally. */
        const stubFdLink = (resolveFdLink: (fdPath: string) => Promise<string>) => {
            realpathImpl = async (p: fs.PathLike) => {
                const asString = p as string;
                return /^\/(proc\/self|dev)\/fd\/\d+$/.test(asString)
                    ? resolveFdLink(asString)
                    : realFsp.realpath(asString);
            };
        };

        const readText = () => readAttachments([{ name: 'note.txt', path: file, type: 'file' }]);
        const readImage = () => readAttachments([{ name: 'pic.png', path: image, type: 'image' }]);

        beforeEach(() => {
            if (process.platform === 'win32') {
                return;
            }
            // Attachments carry canonical paths, so the fixture dir is canonicalized
            // (macOS tmpdir is itself a symlink).
            dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-fd-')));
            file = path.join(dir, 'note.txt');
            fs.writeFileSync(file, 'fd-anchored content');
            image = path.join(dir, 'pic.png');
            fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        });

        afterEach(() => {
            Object.defineProperty(process, 'platform', originalPlatform);
            if (process.platform === 'win32') {
                return;
            }
            fs.rmSync(dir, { recursive: true, force: true });
        });

        posixOnly('accepts a Linux attachment whose fd link resolves to the stored path', async () => {
            setPlatform('linux');
            stubFdLink(async () => file);
            const { prompt } = await readText();
            expect(prompt).toContain('fd-anchored content');
        });

        posixOnly('rejects a Linux attachment whose fd link points elsewhere', async () => {
            setPlatform('linux');
            stubFdLink(async () => '/etc/passwd');
            const { prompt } = await readText();
            expect(prompt).not.toContain('fd-anchored content');
            expect(prompt).toContain('[Could not read file]');
        });

        posixOnly('fails closed on Linux when /proc/self/fd cannot be resolved', async () => {
            setPlatform('linux');
            stubFdLink(async () => {
                throw new Error('ENOENT');
            });
            const { prompt } = await readText();
            expect(prompt).not.toContain('fd-anchored content');
        });

        posixOnly('accepts text and images on macOS, where /dev/fd echoes its own path', async () => {
            setPlatform('darwin');
            stubFdLink(async (fdPath) => fdPath);
            const text = await readText();
            expect(text.prompt).toContain('fd-anchored content');
            const imageResult = await readImage();
            expect(imageResult.attachments).toHaveLength(1);
        });

        posixOnly('accepts an attachment when /dev/fd is not mounted', async () => {
            setPlatform('freebsd');
            stubFdLink(async () => {
                throw new Error('ENOENT');
            });
            const { prompt } = await readText();
            expect(prompt).toContain('fd-anchored content');
        });

        posixOnly('rejects text and images when /dev/fd proves a different location', async () => {
            setPlatform('darwin');
            stubFdLink(async () => '/private/etc/passwd');
            const text = await readText();
            expect(text.prompt).not.toContain('fd-anchored content');
            const imageResult = await readImage();
            expect(imageResult.prompt).not.toContain('<image');
        });
    });

    describe('readAttachments content limits', () => {
        const posixOnly = process.platform === 'win32' ? it.skip : it;
        let dir: string;

        const writeFixture = (name: string, content: string | Buffer) => {
            const file = path.join(dir, name);
            fs.writeFileSync(file, content);
            return file;
        };

        beforeEach(() => {
            dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-limits-')));
        });

        afterEach(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        posixOnly('skips a text attachment containing NUL bytes as binary in both modes', async () => {
            const file = writeFixture('notes.txt', Buffer.from('hello from notepad', 'utf16le'));
            for (const imageMode of ['attachment', 'contentBlock'] as const) {
                const { prompt } = await readAttachments([{ name: 'notes.txt', path: file, type: 'file' }], { imageMode });
                expect(prompt).toContain('[Binary file skipped]');
                expect(prompt).not.toContain('\0');
            }
        });

        posixOnly('slices a ranged mention before applying the size cap', async () => {
            const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`);
            const file = writeFixture('big.ts', lines.join('\n'));
            const { prompt } = await readAttachments(
                [{ name: 'big.ts', path: file, type: 'file', lineStart: 1, lineEnd: 3 }],
                { imageMode: 'contentBlock' }
            );
            expect(prompt).toContain(lines.slice(0, 3).join('\n'));
            expect(prompt).not.toContain('line 4 ');
        });

        posixOnly.each([
            [5, 10, '5-10'],
            [5, undefined, '5'],
            [7, 3, '7'],
        ])('names the #L%s-%s slice it sends as lines="%s"', async (lineStart, lineEnd, label) => {
            const file = writeFixture('ranged.ts', Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'));
            const { prompt } = await readAttachments([{ name: 'ranged.ts', path: file, type: 'file', lineStart, lineEnd }]);
            expect(prompt).toMatch(new RegExp(`^<file-[0-9a-f-]{36} path="[^"]*ranged\\.ts" lines="${label}">\\nline ${lineStart}\\b`));
        });

        posixOnly('frames a whole file without a lines attribute', async () => {
            const file = writeFixture('whole.ts', 'body');
            const { prompt } = await readAttachments([{ name: 'whole.ts', path: file, type: 'file' }]);
            expect(prompt).not.toContain('lines=');
        });

        posixOnly('charges only the sliced text of a ranged mention against the payload budget', async () => {
            const file = writeFixture('big.ts', `wanted\n${'y'.repeat(100 * 1024)}`);
            const { prompt } = await readAttachments(
                [{ name: 'big.ts', path: file, type: 'file', lineStart: 1 }],
                { limits: withBudget(2 * 1024) }
            );
            expect(prompt).toContain('wanted');
        });

        posixOnly('rejects a ranged slice that still exceeds the size cap', async () => {
            const file = writeFixture('one-line.ts', 'z'.repeat(10 * 1024 * 1024 + 1));
            const { prompt } = await readAttachments(
                [{ name: 'one-line.ts', path: file, type: 'file', lineStart: 1 }],
                { imageMode: 'contentBlock' }
            );
            expect(prompt).toContain('[Attachment skipped: file exceeds size limit]');
        });

        posixOnly('charges the section framing, not just the file bytes, against the payload budget', async () => {
            const content = 'c'.repeat(1000);
            const file = writeFixture('exact.txt', content);
            const { prompt } = await readAttachments(
                [{ name: 'exact.txt', path: file, type: 'file' }],
                { imageMode: 'contentBlock', limits: withBudget(content.length) }
            );
            expect(prompt).not.toContain(content);
            expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(content.length);
        });

        posixOnly('notes skipped attachments even when no rejection marker fits', async () => {
            const file = writeFixture('a.txt', 'content');
            const { prompt } = await readAttachments(
                [{ name: 'a.txt', path: file, type: 'file' }],
                { imageMode: 'contentBlock', limits: withBudget(0) }
            );
            expect(prompt).toBe('[Some attachments were skipped: attachment size limit reached]');
        });

        posixOnly('charges text by its JSON-escaped size, as it travels', async () => {
            const control = '\x01'.repeat(1000);
            const file = writeFixture('control.txt', control);
            const { prompt } = await readAttachments(
                [{ name: 'control.txt', path: file, type: 'file' }],
                { imageMode: 'contentBlock', limits: withBudget(3000) }
            );
            expect(prompt).not.toContain(control);
        });

        posixOnly('reserves the base prompt by its JSON-escaped size', async () => {
            const file = writeFixture('a.txt', 'body');
            const basePrompt = '"'.repeat(1000);
            const read = (budget: number) => readAttachments([{ name: 'a.txt', path: file, type: 'file' }], { basePrompt, limits: withBudget(budget) });
            // The raw prompt is 1000 bytes, escaped 2000: only the escaped size leaves the file no room.
            expect((await read(1500)).prompt).not.toContain('body');
            expect((await read(2400)).prompt).toContain('body');
        });

        posixOnly('caps a text attachment at the transport\'s per-file limit', async () => {
            const file = writeFixture('mid.txt', 'm'.repeat(4096));
            const { prompt } = await readAttachments([{ name: 'mid.txt', path: file, type: 'file' }], {
                limits: withBudget(1024 * 1024, { attachmentMaxBytes: 4095 }),
            });
            expect(prompt).toContain('[Attachment skipped: file exceeds size limit]');
        });

        posixOnly('reads a small attachment without allocating the size cap', async () => {
            const file = writeFixture('small.txt', 'tiny');
            const alloc = jest.spyOn(Buffer, 'alloc');
            const allocUnsafe = jest.spyOn(Buffer, 'allocUnsafe');
            try {
                const { prompt } = await readAttachments([{ name: 'small.txt', path: file, type: 'file' }]);
                expect(prompt).toContain('tiny');
                const sizes = [...alloc.mock.calls, ...allocUnsafe.mock.calls].map(([size]) => size);
                expect(Math.max(0, ...sizes)).toBeLessThan(1024 * 1024);
            } finally {
                alloc.mockRestore();
                allocUnsafe.mockRestore();
            }
        });
    });

    describe('readAttachments verification', () => {
        const posixOnly = process.platform === 'win32' ? it.skip : it;
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        let dir: string;

        const writeFixture = (name: string, content: string | Buffer) => {
            const file = path.join(dir, name);
            fs.writeFileSync(file, content);
            return file;
        };
        const readOne = (file: string, type: 'file' | 'image' = 'file', imageMode: 'attachment' | 'contentBlock' = 'attachment') =>
            readAttachments([{ name: path.basename(file), path: file, type }], { imageMode });

        beforeEach(() => {
            dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-verify-')));
        });

        afterEach(() => {
            Object.defineProperty(process, 'platform', originalPlatform);
            fs.rmSync(dir, { recursive: true, force: true });
        });

        posixOnly('rejects a path that no longer resolves to itself before opening it', async () => {
            const file = writeFixture('a.txt', 'secret');
            const link = path.join(dir, 'link.txt');
            fs.symlinkSync(file, link);
            for (const type of ['file', 'image'] as const) {
                const { prompt } = await readOne(link, type);
                expect(prompt).toContain('[Could not read file]');
                expect(prompt).not.toContain('secret');
            }
        });

        posixOnly('rejects a file swapped between open and the identity check', async () => {
            const file = writeFixture('a.txt', 'original');
            const other = writeFixture('b.txt', 'other');
            (globalThis as any).__lstatImpl = (p: fs.PathLike) => realFsp.lstat(p === file ? other : p);
            const { prompt } = await readOne(file);
            expect(prompt).toContain('[Could not read file]');
            expect(prompt).not.toContain('original');
        });

        posixOnly('rejects a directory', async () => {
            const sub = path.join(dir, 'sub');
            fs.mkdirSync(sub);
            expect((await readOne(sub)).prompt).toContain('[Could not read file]');
        });

        posixOnly('rejects a text file that grows past the cap after stat', async () => {
            const file = writeFixture('grow.txt', 'g'.repeat(10 * 1024 * 1024 - 1024));
            realpathImpl = async (p: fs.PathLike) => {
                if (/^\/proc\/self\/fd\//.test(p as string)) {
                    fs.appendFileSync(file, 'g'.repeat(10 * 1024));
                }
                return realFsp.realpath(p as string);
            };
            Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
            const { prompt } = await readOne(file, 'file', 'contentBlock');
            expect(prompt).toContain('[Attachment skipped: file exceeds size limit]');
        });

        posixOnly('reads without O_NOFOLLOW or an fd check on Windows', async () => {
            const file = writeFixture('w.txt', 'windows body');
            Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
            expect((await readOne(file)).prompt).toContain('windows body');
        });

        posixOnly('reports an image over the gateway\'s default image cap as over the size limit', async () => {
            const image = writeFixture('huge.png', Buffer.alloc(6 * 1024 * 1024 + 1));
            const { prompt } = await readOne(image, 'image');
            expect(prompt).toContain('[Attachment skipped: file exceeds size limit]');
            expect(prompt).not.toContain('<image');
        });

        posixOnly('reports a missing image as unreadable, framed with its path', async () => {
            const { prompt } = await readOne(path.join(dir, 'gone.png'), 'image');
            expect(prompt).toMatch(/<file-[0-9a-f-]+ path="[^"]*gone\.png">\n\[Could not read file\]/);
        });
    });

    describe('readAttachments images', () => {
        const posixOnly = process.platform === 'win32' ? it.skip : it;
        let dir: string;

        const writeImage = (name: string, size = 4) => {
            const file = path.join(dir, name);
            fs.writeFileSync(file, Buffer.alloc(size, 1));
            return { name, path: file, type: 'image' as const };
        };

        beforeEach(() => {
            dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-img-')));
        });

        afterEach(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        const stagedIds = (prompt: string) => [...prompt.matchAll(/<image ref="([0-9a-f-]{36})" \/>/g)].map(match => match[1]);

        posixOnly.each([
            ['a.png', 'image/png'], ['a.JPG', 'image/jpeg'], ['a.jpeg', 'image/jpeg'], ['a.gif', 'image/gif'],
            ['a.webp', 'image/webp'], ['a.bmp', 'image/bmp'], ['a.svg', 'image/svg+xml'],
            ['a.ico', 'image/vnd.microsoft.icon'], ['a.tif', 'image/tiff'], ['a.tiff', 'image/tiff'],
            ['a.raw', 'application/octet-stream'],
        ])('hands %s to the gateway as a %s attachment, keeping it out of the prompt', async (name, mime) => {
            const { prompt, attachments } = await readAttachments([writeImage(name)]);
            expect(prompt).toBe('');
            expect(attachments).toEqual([{ name, mimeType: mime, data: Buffer.alloc(4, 1) }]);
        });

        posixOnly('charges each gateway image what it adds to the send', async () => {
            const wireBytes = jest.fn(() => 500);
            const read = (budget: number) =>
                readAttachments([writeImage('a.png', 300), writeImage('b.png', 300)], { limits: withBudget(budget), attachmentWireBytes: wireBytes });
            expect((await read(1000)).attachments.map((a) => a.name)).toEqual(['a.png', 'b.png']);
            const tight = await read(999);
            expect(tight.attachments.map((a) => a.name)).toEqual(['a.png']);
            expect(tight.prompt).toContain('[Attachment skipped: aggregate attachment size limit reached]');
            expect(wireBytes).toHaveBeenCalledWith({ name: 'a.png', mimeType: 'image/png', byteLength: 300 });
        });

        posixOnly('budgets gateway images by their base64 frame cost by default', async () => {
            const { prompt, attachments } = await readAttachments([writeImage('a.png', 3000)], { limits: withBudget(1000) });
            expect(attachments).toEqual([]);
            expect(prompt).toContain('[Attachment skipped: aggregate attachment size limit reached]');
        });

        posixOnly('takes the per-image cap from the transport limits', async () => {
            const limits = withBudget(1024 * 1024, { attachmentMaxImageBytes: 99 });
            const { prompt } = await readAttachments([writeImage('a.png', 100)], { limits });
            expect(prompt).toContain('[Attachment skipped: file exceeds size limit]');
        });

        posixOnly('stages images as ACP blocks for acpx and releases them on dispose', async () => {
            const { prompt, dispose } = await readAttachments([writeImage('a.png'), writeImage('b.gif')], { imageMode: 'contentBlock' });
            const ids = stagedIds(prompt);
            expect(ids).toHaveLength(2);
            expect(stagedPromptImage(ids[0])).toEqual({ name: 'a.png', mimeType: 'image/png', data: 'AQEBAQ==' });
            expect(stagedPromptImage(ids[1])).toEqual({ name: 'b.gif', mimeType: 'image/gif', data: 'AQEBAQ==' });
            expect(prompt).not.toContain('base64');
            await dispose();
            expect(ids.map(stagedPromptImage)).toEqual([undefined, undefined]);
        });

        posixOnly('charges a staged image\'s base64 against the payload budget', async () => {
            const threeKiB = 3 * 1024;
            const { prompt, dispose } = await readAttachments(
                [writeImage('a.png', threeKiB), writeImage('b.png', threeKiB)],
                { imageMode: 'contentBlock', limits: withBudget(6 * 1024) }
            );
            expect(stagedIds(prompt)).toHaveLength(1);
            expect(prompt).toContain('[Attachment skipped: aggregate attachment size limit reached]');
            await dispose();
        });

        posixOnly('stages nothing for a rejected image', async () => {
            const { prompt } = await readAttachments([writeImage('a.png', 100)], { imageMode: 'contentBlock', limits: withBudget(50) });
            expect(stagedIds(prompt)).toEqual([]);
        });
    });
});
