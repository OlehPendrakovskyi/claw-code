import * as fs from 'fs';
import * as path from 'path';
import { CLIENT_VERSION } from '../core/constants';

const PACKAGE_JSON = path.resolve(__dirname, '..', '..', 'package.json');

describe('constants', () => {
    describe('CLIENT_VERSION', () => {
        it('falls back to the package.json version when esbuild has not injected one', () => {
            const manifest: unknown = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
            expect(manifest).toMatchObject({ version: CLIENT_VERSION });
        });
    });
});
