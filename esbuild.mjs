import * as esbuild from 'esbuild';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';

const require = createRequire(import.meta.url);
const { version } = require('./package.json');

/** The extension is packaged without node_modules (`vsce package --no-dependencies`), so koffi and the
 *  binaries of the platforms that use it (src/core/handlePath.ts) are copied beside the bundle. Being the
 *  nearest node_modules to koffi, this copy is also where koffi finds its binary first. */
const NATIVE_MODULES = 'out/native/node_modules';
const KOFFI_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'];
const KOFFI_RUNTIME_FILES = ['package.json', 'LICENSE.txt', 'index.cjs', 'src/koffi/index.cjs', 'src/koffi/src/static.cjs'];

function copyKoffi() {
    const koffiDir = fs.realpathSync('node_modules/koffi');
    const target = path.join(NATIVE_MODULES, 'koffi');
    fs.rmSync(NATIVE_MODULES, { recursive: true, force: true });
    for (const file of KOFFI_RUNTIME_FILES) {
        fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
        fs.copyFileSync(path.join(koffiDir, file), path.join(target, file));
    }
    // pnpm keeps a package's dependencies beside it, so the binary packages sit next to koffi's real directory.
    for (const platform of KOFFI_PLATFORMS) {
        const name = `@koromix/koffi-${platform}`;
        fs.cpSync(path.join(koffiDir, '..', name), path.join(NATIVE_MODULES, name), { recursive: true, dereference: true });
    }
}

/** Resolves `koffi` to the copy above, relative to the bundle, so no other node_modules is searched. */
const koffiFromNativeModules = {
    name: 'koffi-from-native-modules',
    setup(build) {
        build.onResolve({ filter: /^koffi$/ }, () => ({ path: './native/node_modules/koffi/index.cjs', external: true }));
    },
};

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    define: { __CLIENT_VERSION__: JSON.stringify(version) },
    platform: 'node',
    outfile: 'out/extension.js',
    external: ['vscode'],
    plugins: [koffiFromNativeModules],
    logLevel: 'info',
    banner: {
        js: 'if(typeof HTMLElement==="undefined"){globalThis.HTMLElement=class HTMLElement{};}',
    },
});

copyKoffi();

if (watch) {
    await ctx.watch();
} else {
    await ctx.rebuild();
    await ctx.dispose();
}
