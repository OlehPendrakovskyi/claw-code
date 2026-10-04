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
        // Measured only with --coverage (CI's Linux leg). The thresholds sit just below the
        // coverage measured when they were introduced (2026-10-04: statements 88.4%, branches
        // 86.6%, functions 89.7%, lines 88.3%), so a drop fails CI; raise them as coverage grows.
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/__test__/**'],
            reporter: ['text-summary'],
            thresholds: { statements: 88, branches: 86, functions: 89, lines: 88 },
        },
    },
    resolve: {
        alias: [
            { find: /^vscode$/, replacement: path.resolve(process.cwd(), 'src/__test__/vscode.mock.ts') },
        ],
    },
});
