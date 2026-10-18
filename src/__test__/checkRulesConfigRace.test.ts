import * as fs from 'fs';
import * as path from 'path';
import { API } from 'typescript/unstable/sync';
import { checkRules } from '../../scripts/check-rules.mjs';
import { makeTempDir } from './helpers/tempDir';

// The config appears between an existence check and the write (CodeQL js/file-system-race): an `existsSync`
// call always answers that it is missing, as it would for a run that checked just before another one wrote it.
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: () => false }));

describe('scripts/check-rules.mjs minimal tsconfig', () => {
    it('keeps a tsconfig-check-rules.json created after any check it could make', () => {
        const root = makeTempDir('claw-check-rules-');
        const api = new API({ cwd: process.cwd() });
        try {
            const config = path.join(root, 'tsconfig-check-rules.json');
            const own = `${JSON.stringify({ compilerOptions: { noResolve: true, noLib: true, types: [] } }, null, 4)}\n`;
            fs.writeFileSync(config, own);
            fs.mkdirSync(path.join(root, 'src'));
            fs.writeFileSync(path.join(root, 'src', 'ok.ts'), 'const ok = 1;\n');

            expect(checkRules(root, api).findings).toEqual([]);
            expect(fs.readFileSync(config, 'utf8')).toBe(own);
        } finally {
            api.close();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
