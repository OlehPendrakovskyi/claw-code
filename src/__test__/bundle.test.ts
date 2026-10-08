
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'out', 'extension.js');
/** Where esbuild.mjs copies koffi, and the specifier the bundle imports it by. */
const NATIVE_MODULES = path.join(ROOT, 'out', 'native', 'node_modules');
const KOFFI_SPECIFIER = './native/node_modules/koffi/index.cjs';
const KOFFI_BINARIES = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'];
const usesKoffi = process.platform === 'darwin' || process.platform === 'win32';

describe('bundled output', () => {
    beforeAll(() => {
        // Node by its absolute path and an argv vector: no shell (development rules R30, R36).
        execFileSync(process.execPath, ['esbuild.mjs', '--production'], { cwd: ROOT, stdio: 'pipe' });
    });

    it('produces out/extension.js', () => {
        expect(fs.existsSync(OUT)).toBe(true);
    });

    it('bundle is a reasonable size (50KB–500KB)', () => {
        const stats = fs.statSync(OUT);
        expect(stats.size).toBeGreaterThan(50_000);
        expect(stats.size).toBeLessThan(500_000);
    });

    it('contains the HTMLElement polyfill banner', () => {
        const head = fs.readFileSync(OUT, 'utf8').slice(0, 200);
        expect(head).toContain('HTMLElement');
    });

    it('does not require @create-markdown at runtime (bundled inline)', () => {
        const src = fs.readFileSync(OUT, 'utf8');
        expect(src).not.toMatch(/require\(["']@create-markdown/);
    });

    it('marks vscode as external', () => {
        const src = fs.readFileSync(OUT, 'utf8');
        expect(src).toMatch(/require\(["']vscode["']\)/);
    });

    it('imports koffi only from the copy beside the bundle', () => {
        const src = fs.readFileSync(OUT, 'utf8');
        expect(src).toContain(`import("${KOFFI_SPECIFIER}")`);
        expect(src).not.toMatch(/(?:require|import)\(["']koffi["']\)/);
    });

    it('copies koffi with the macOS and Windows binaries the packaged extension loads', () => {
        expect(fs.existsSync(path.join(NATIVE_MODULES, 'koffi', 'index.cjs'))).toBe(true);
        for (const platform of KOFFI_BINARIES) {
            const triplet = platform.replace('-', '_');
            expect(fs.existsSync(path.join(NATIVE_MODULES, '@koromix', `koffi-${platform}`, triplet, 'koffi.node'))).toBe(true);
        }
    });

    // The handle-path tests import koffi from the workspace; this loads the packaged copy, as the bundle resolves it.
    (usesKoffi ? it : it.skip)('loads the copied koffi, with its binary from the copy, and calls into the OS', () => {
        const requireFromBundle = createRequire(OUT);
        const koffi = requireFromBundle(KOFFI_SPECIFIER).default;
        const nativeBinary = Object.keys(requireFromBundle.cache).find((file) => file.endsWith('koffi.node'));
        expect(nativeBinary?.startsWith(NATIVE_MODULES)).toBe(true);
        const processId = process.platform === 'win32'
            ? koffi.load('kernel32.dll').func('uint32 GetCurrentProcessId()')
            : koffi.load('/usr/lib/libSystem.B.dylib').func('int getpid()');
        expect(processId()).toBe(process.pid);
    });

    it('exports activate and deactivate symbols', () => {
        const src = fs.readFileSync(OUT, 'utf8');
        expect(src).toContain('activate');
        expect(src).toContain('deactivate');
    });
});
