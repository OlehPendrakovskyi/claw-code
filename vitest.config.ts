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
        // Measured only with --coverage (CI's Linux leg). CI fails when any metric falls below its
        // threshold. The thresholds sit just below the coverage measured when they were set
        // (2026-10-04: statements 95.2%, branches 93.5%, functions 93.7%, lines 95.4%), so only a drop
        // past that margin fails, not every drop. Keep them at 90 or above and raise them as coverage grows.
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/__test__/**'],
            reporter: ['text-summary'],
            thresholds: { statements: 95, branches: 93, functions: 93, lines: 95 },
        },
    },
    resolve: {
        alias: [
            { find: /^vscode$/, replacement: path.resolve(process.cwd(), 'src/__test__/vscode.mock.ts') },
        ],
    },
});
