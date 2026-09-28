import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as FspType from 'fs/promises';
import { readAttachments } from '../webview/viewMessaging';

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
        },
    };
});
beforeEach(() => {
    (globalThis as any).__realpathImpl = (p: fs.PathLike) => realpathImpl(p);
});
afterEach(() => {
    (globalThis as any).__realpathImpl = undefined;
    realpathImpl = (p) => realFsp.realpath(p as string);
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
                { reservedPromptBytes: 20 * 1024 * 1024 - 5 * 1024 }
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
        const image = await readImage();
        expect(image.prompt).toContain('<image');
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
        const image = await readImage();
        expect(image.prompt).not.toContain('<image');
    });
});
