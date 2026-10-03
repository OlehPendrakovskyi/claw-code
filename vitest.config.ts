/**
 * Vitest replaces ts-jest here: the transform runs through esbuild, so a
 * worker no longer holds the TypeScript language service, and ESM-only
 * dependencies load natively instead of needing a CJS transform.
 */
import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/__test__/**/*.test.ts'],
        setupFiles: ['./src/__test__/setup.ts'],
    },
    resolve: {
        alias: [
            { find: /^vscode$/, replacement: path.resolve(process.cwd(), 'src/__test__/vscode.mock.ts') },
        ],
    },
});
