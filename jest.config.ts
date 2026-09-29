import type { JestConfigWithTsJest } from 'ts-jest';
import * as path from 'path';

const config: JestConfigWithTsJest = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src/__test__'],
    testMatch: ['**/*.test.ts'],
    setupFiles: ['<rootDir>/src/__test__/setup.ts'],
    // ts-jest workers hold the TypeScript language service (~150 MB); tearing it
    // down can outlast jest-worker's 500 ms default and trip a false leak warning.
    workerGracefulExitTimeout: 3000,
    moduleNameMapper: {
        '^vscode$': path.resolve(process.cwd(), 'src/__test__/vscode.mock.ts'),
        '^lodash-es$': 'lodash',
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
};

export default config;