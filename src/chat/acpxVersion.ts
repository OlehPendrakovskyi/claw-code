/**
 * Claw Code — which acpx the chat runs, checked against the versions it was tested with.
 *
 * acpx is installed by the user, so any release can be on PATH. What the extension relies
 * on (stderr content, flags, exit codes; development rule R29) was read from the source of
 * the tested releases only, so another version gets a warning. The chat is never blocked.
 */

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import type { CliLaunch } from '../core/cliLauncher';
import { envWithAbsolutePath } from '../core/searchPath';

/** The oldest acpx release the extension was tested with. */
export const ACPX_TESTED_FROM = '0.19.4';
/** The first acpx release it was not tested with; raising it means re-reading that release's source (R24). */
export const ACPX_UNTESTED_FROM = '0.20.0';

const VERSION_TIMEOUT_MS = 5000;
const VERSION_MAX_BUFFER_BYTES = 64 * 1024;
const RELEASE_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

type Release = [number, number, number];

/** Results by the whole launch, so each acpx is asked once per session: on Windows the command is the
 *  shared `node.exe`, and the acpx is the script in its arguments. */
const checked = new Map<string, Promise<void>>();

/** The release `acpx --version` printed on its first line; undefined for anything else, a prerelease or
 *  acpx's own `0.0.0-unknown` included. */
export function parseAcpxVersion(stdout: string): Release | undefined {
    const match = RELEASE_PATTERN.exec(stdout.split(/\r?\n/, 1)[0].trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareReleases(a: Release, b: Release): number {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function isTestedAcpxVersion(release: Release): boolean {
    return compareReleases(release, parseAcpxVersion(ACPX_TESTED_FROM)!) >= 0
        && compareReleases(release, parseAcpxVersion(ACPX_UNTESTED_FROM)!) < 0;
}

/** Asks `launch`'s acpx for its version once per session, and warns when it is untested or unknown.
 *  Settles when that one check has been reported; it never rejects. */
export function checkAcpxVersionOnce(launch: CliLaunch, log: vscode.LogOutputChannel): Promise<void> {
    const key = JSON.stringify([launch.command, ...launch.args]);
    let check = checked.get(key);
    if (!check) {
        check = readVersionOutput(launch).then((stdout) => report(stdout, log), () => undefined);
        checked.set(key, check);
    }
    return check;
}

/** Forgets every result; for tests. */
export function resetAcpxVersionChecks(): void {
    checked.clear();
}

/** acpx's `--version` output, or undefined when it failed or timed out. */
function readVersionOutput(launch: CliLaunch): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile(launch.command, [...launch.args, '--version'], {
            env: envWithAbsolutePath(),
            shell: false,
            windowsHide: true,
            timeout: VERSION_TIMEOUT_MS,
            maxBuffer: VERSION_MAX_BUFFER_BYTES,
        }, (err, stdout) => resolve(err ? undefined : String(stdout)));
    });
}

function report(stdout: string | undefined, log: vscode.LogOutputChannel): void {
    const release = stdout === undefined ? undefined : parseAcpxVersion(stdout);
    if (release && isTestedAcpxVersion(release)) {
        log.info(`acpx ${release.join('.')}`);
        return;
    }
    // The raw output is never logged: only a parsed release, or how much there was.
    if (release) {
        log.warn(`acpx ${release.join('.')} is untested`);
    } else {
        log.warn(stdout === undefined ? 'acpx --version failed or timed out' : `acpx --version printed no release (${stdout.length} chars)`);
    }
    const tested = `${ACPX_TESTED_FROM} or later, before ${ACPX_UNTESTED_FROM}`;
    void vscode.window.showWarningMessage(release
        ? `acpx ${release.join('.')} is outside the versions Claw Code was tested with (${tested}). Chat may not work as expected.`
        : `The acpx version could not be read, so Claw Code cannot tell whether it was tested with it (${tested}). Chat may not work as expected.`);
}
