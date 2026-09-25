import { splitHardeningCommand } from '../core/hardeningCommand';

describe('splitHardeningCommand', () => {
    it('parses a plain executable', () => {
        expect(splitHardeningCommand('openclaw')).toEqual({ executable: 'openclaw', args: [] });
    });

    it('parses executable with plain arguments', () => {
        expect(splitHardeningCommand('openclaw --verbose')).toEqual({
            executable: 'openclaw',
            args: ['--verbose']
        });
    });

    it('collapses extra whitespace', () => {
        expect(splitHardeningCommand('  openclaw    status  ')).toEqual({
            executable: 'openclaw',
            args: ['status']
        });
    });

    it('supports quoted arguments without shell semantics', () => {
        expect(splitHardeningCommand('openclaw --name "my tool"')).toEqual({
            executable: 'openclaw',
            args: ['--name', 'my tool']
        });
        expect(splitHardeningCommand("node '/path with space/cli.js'")).toEqual({
            executable: 'node',
            args: ['/path with space/cli.js']
        });
    });

    it('rejects shell metacharacters', () => {
        for (const bad of [
            'openclaw; rm -rf ~',
            'openclaw && echo pwned',
            'openclaw | tee /tmp/x',
            'echo $HOME',
            'openclaw `id`',
            'openclaw > /tmp/out',
            'openclaw < /etc/passwd',
            'openclaw (subshell)',
            'openclaw\necho pwned'
        ]) {
            expect(splitHardeningCommand(bad)).toBeNull();
        }
    });

    it('rejects unbalanced quotes, empty and blank input', () => {
        expect(splitHardeningCommand('openclaw "unbalanced')).toBeNull();
        expect(splitHardeningCommand('')).toBeNull();
        expect(splitHardeningCommand('   ')).toBeNull();
    });
});