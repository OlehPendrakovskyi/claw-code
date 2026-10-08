import * as fs from 'fs';
import * as path from 'path';
import { CLIENT_VERSION, DEFAULT_CONNECT_COMMAND, DEFAULT_HARDENING_COMMAND } from '../core/constants';

const PACKAGE_JSON = path.resolve(__dirname, '..', '..', 'package.json');

describe('constants', () => {
    describe('CLIENT_VERSION', () => {
        it('falls back to the package.json version when esbuild has not injected one', () => {
            const manifest: unknown = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
            expect(manifest).toMatchObject({ version: CLIENT_VERSION });
        });
    });

    describe('command setting defaults', () => {
        // A blank setting falls back to the constant and an unset one to the manifest default; they must be the same command.
        it.each([
            ['openclaw.command', DEFAULT_CONNECT_COMMAND],
            ['openclaw.hardening.command', DEFAULT_HARDENING_COMMAND],
        ])('%s defaults in package.json to the same command as the code fallback', (setting, fallback) => {
            const manifest: unknown = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
            expect(manifest).toMatchObject({ contributes: { configuration: { properties: { [setting]: { default: fallback } } } } });
        });
    });
});
