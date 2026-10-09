import * as vscode from 'vscode';
import { execFile } from 'child_process';
import {
    ACPX_TESTED_FROM,
    ACPX_UNTESTED_FROM,
    checkAcpxVersionOnce,
    isTestedAcpxVersion,
    parseAcpxVersion,
    resetAcpxVersionChecks,
} from '../chat/acpxVersion';

// The whole export surface, checked at compile time (development rule R50).
vi.mock('child_process', () => ({
    ChildProcess: class {} as unknown as typeof import('child_process').ChildProcess,
    exec: vi.fn() as unknown as typeof import('child_process').exec,
    execFile: vi.fn() as unknown as typeof import('child_process').execFile,
    execFileSync: vi.fn() as unknown as typeof import('child_process').execFileSync,
    execSync: vi.fn() as unknown as typeof import('child_process').execSync,
    fork: vi.fn() as unknown as typeof import('child_process').fork,
    spawn: vi.fn() as unknown as typeof import('child_process').spawn,
    spawnSync: vi.fn() as unknown as typeof import('child_process').spawnSync,
} satisfies typeof import('child_process')));

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.mocked(execFile as unknown as (command: string, args: string[], options: object, callback: ExecFileCallback) => void);
const warningMock = vi.mocked(vscode.window.showWarningMessage);
const log = vscode.window.createOutputChannel('acpx version test', { log: true });
const LAUNCH = { command: '/usr/local/bin/acpx', args: [] };

/** acpx answers `--version` with `stdout`, or fails with `err`. */
function acpxAnswers(stdout: string, err: Error | null = null): void {
    execFileMock.mockImplementation((_command, _args, _options, callback) => callback(err, stdout, ''));
}

describe('acpxVersion', () => {
    beforeEach(() => {
        resetAcpxVersionChecks();
        execFileMock.mockReset();
        warningMock.mockClear();
        vi.mocked(log.info).mockClear();
        vi.mocked(log.warn).mockClear();
    });

    describe('parseAcpxVersion', () => {
        it('reads the release acpx prints on its first line', () => {
            expect(parseAcpxVersion('0.19.4')).toEqual([0, 19, 4]);
            expect(parseAcpxVersion(' 0.19.4\r\nmore\n')).toEqual([0, 19, 4]);
        });

        it.each([
            ['acpx\'s own unknown version', '0.0.0-unknown'],
            ['a prerelease', '1.0.0-beta.1'],
            ['empty output', ''],
            ['text', 'acpx version 0.19.4'],
        ])('reads no release from %s', (_label, stdout) => {
            expect(parseAcpxVersion(stdout)).toBeUndefined();
        });
    });

    describe('isTestedAcpxVersion', () => {
        it.each([
            ['0.19.3', false],
            [ACPX_TESTED_FROM, true],
            ['0.19.99', true],
            [ACPX_UNTESTED_FROM, false],
            ['1.0.0', false],
        ])('counts %s as tested: %s', (version, tested) => {
            expect(isTestedAcpxVersion(parseAcpxVersion(version)!)).toBe(tested);
        });
    });

    describe('checkAcpxVersionOnce', () => {
        it('asks the launched acpx for --version without a shell, on a timeout', async () => {
            acpxAnswers('0.19.4\n');
            await checkAcpxVersionOnce({ command: process.execPath, args: ['/opt/acpx/dist/cli.js'] }, log);
            expect(execFileMock).toHaveBeenCalledWith(
                process.execPath,
                ['/opt/acpx/dist/cli.js', '--version'],
                expect.objectContaining({ shell: false, timeout: 5000 }),
                expect.any(Function),
            );
        });

        it('logs a tested version and does not warn', async () => {
            acpxAnswers('0.19.4\n');
            await checkAcpxVersionOnce(LAUNCH, log);
            expect(log.info).toHaveBeenCalledWith('acpx 0.19.4');
            expect(warningMock).not.toHaveBeenCalled();
        });

        it('warns once about an untested version', async () => {
            acpxAnswers('0.21.0\n');
            await checkAcpxVersionOnce(LAUNCH, log);
            expect(log.warn).toHaveBeenCalledWith('acpx 0.21.0 is untested');
            expect(warningMock).toHaveBeenCalledTimes(1);
            expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('acpx 0.21.0 is outside the versions Claw Code was tested with'));
        });

        it('warns about an unknown version, and logs only how much acpx printed', async () => {
            acpxAnswers('0.0.0-unknown\n');
            await checkAcpxVersionOnce(LAUNCH, log);
            expect(log.warn).toHaveBeenCalledWith('acpx --version printed no release (14 chars)');
            expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('The acpx version could not be read'));
            expect(warningMock).not.toHaveBeenCalledWith(expect.stringContaining('is outside'));
        });

        it('warns when acpx fails or times out', async () => {
            acpxAnswers('', Object.assign(new Error('timed out'), { killed: true }));
            await checkAcpxVersionOnce(LAUNCH, log);
            expect(log.warn).toHaveBeenCalledWith('acpx --version failed or timed out');
            expect(warningMock).toHaveBeenCalledTimes(1);
        });

        it('names the tested range with its excluded upper bound', async () => {
            acpxAnswers(`${ACPX_UNTESTED_FROM}\n`);
            await checkAcpxVersionOnce(LAUNCH, log);
            expect(warningMock).toHaveBeenCalledWith(expect.stringContaining(`(${ACPX_TESTED_FROM} or later, before ${ACPX_UNTESTED_FROM})`));
        });

        it('asks each acpx once per session', async () => {
            acpxAnswers('0.21.0\n');
            await checkAcpxVersionOnce(LAUNCH, log);
            await checkAcpxVersionOnce(LAUNCH, log);
            expect(execFileMock).toHaveBeenCalledTimes(1);
            expect(warningMock).toHaveBeenCalledTimes(1);
        });

        it('asks again for another acpx script run by the same node, as on Windows', async () => {
            acpxAnswers('0.21.0\n');
            await checkAcpxVersionOnce({ command: 'C:\\node\\node.exe', args: ['C:\\one\\acpx\\dist\\cli.js'] }, log);
            await checkAcpxVersionOnce({ command: 'C:\\node\\node.exe', args: ['C:\\two\\acpx\\dist\\cli.js'] }, log);
            expect(execFileMock).toHaveBeenCalledTimes(2);
        });
    });
});
