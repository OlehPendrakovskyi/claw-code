import * as vscode from 'vscode';

/**
 * The output channel a module created under `name` when it was imported.
 * Call it at a test file's top level, after the imports: by the time a test
 * body runs, the mock's call history is empty, so the channel cannot be
 * looked up from inside a test.
 */
export function outputChannelNamed(name: string): vscode.LogOutputChannel {
    const create = vi.mocked(vscode.window.createOutputChannel);
    const index = create.mock.calls.findIndex(call => (call as unknown[])[0] === name);
    if (index < 0) {
        throw new Error(`No output channel named "${name}" was created`);
    }
    return create.mock.results[index].value as vscode.LogOutputChannel;
}
