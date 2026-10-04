import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';
import { openDebugChatPanel } from '../webview/debugPanel';
import { outputChannelNamed } from './helpers/outputChannels';

const debugLog = outputChannelNamed('OpenClaw Debug');

type Message = Record<string, unknown>;

function loadDebugPanel(): { host(message: Message): void; logLines(): Array<[string, string]>; posted: Message[]; document: Document } {
    const panel = openDebugChatPanel(vscode.Uri.file('/ext'));
    const posted: Message[] = [];
    const dom = new JSDOM(panel.webview.html, {
        runScripts: 'dangerously',
        beforeParse(window) {
            Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: Message) => posted.push(message) }) });
        },
    });
    const { window } = dom;
    return {
        posted,
        document: window.document,
        host: message => window.dispatchEvent(new window.MessageEvent('message', { data: message })),
        logLines: () => Array.from(window.document.querySelectorAll('#log > div'), line => [line.className, line.textContent ?? '']),
    };
}

describe('openDebugChatPanel', () => {
    it('allows only its own nonce-tagged script and style', () => {
        const html = openDebugChatPanel(vscode.Uri.file('/ext')).webview.html;
        const nonce = html.match(/<script nonce="([0-9a-f]+)">/)?.[1];
        expect(html).toContain(`content="default-src 'none'; img-src vscode-webview:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"`);
    });

    describe('logging', () => {
        it('logs only the type of a webview message, never the prompt it carries', () => {
            const info = vi.mocked(debugLog.info);
            info.mockClear();
            const panel = openDebugChatPanel(vscode.Uri.file('/ext'));
            const onMessage = vi.mocked(panel.webview.onDidReceiveMessage).mock.calls[0][0] as (message: unknown) => void;

            onMessage({ type: 'send', text: 'my private prompt', clientId: 'debug-1' });
            onMessage('not a record');

            const logged = info.mock.calls.map(call => String(call[0]));
            expect(logged).toContain('[DebugPanel] message from webview: type=send');
            expect(logged).toContain('[DebugPanel] message from webview: type=unknown');
            expect(logged.join('\n')).not.toContain('my private prompt');
        });
    });

    describe('host messages', () => {
        it('logs a rejected send as an error and an accepted one as success, never as unknown', () => {
            const panel = loadDebugPanel();
            panel.host({ type: 'sendRejected', threadId: 't1', clientId: 'debug-1' });
            panel.host({ type: 'sendAccepted', threadId: 't1', clientId: 'debug-2' });
            panel.host({ type: 'transportStatus', connected: false, label: 'gateway · offline' });
            const lines = panel.logLines().filter(([, text]) => !text.includes('MSG IN')).slice(-3);
            expect(lines.map(([level]) => level)).toEqual(['log-err', 'log-ok', 'log-warn']);
            expect(lines.map(([, text]) => text.replace(/^\[[^\]]+\] /, ''))).toEqual([
                'SEND REJECTED [t1] debug-1',
                'SEND ACCEPTED [t1] debug-2',
                'TRANSPORT: gateway · offline',
            ]);
            expect(panel.logLines().some(([, text]) => text.includes('UNKNOWN'))).toBe(false);
        });
    });

    describe('send', () => {
        it('tags every send with its own clientId', () => {
            const panel = loadDebugPanel();
            const input = panel.document.querySelector('textarea')!;
            const send = panel.document.getElementById('send')!;
            input.value = 'one';
            send.click();
            input.value = 'two';
            send.click();
            expect(panel.posted.filter(m => m.type === 'send')).toEqual([
                { type: 'send', text: 'one', clientId: 'debug-1' },
                { type: 'send', text: 'two', clientId: 'debug-2' },
            ]);
        });
    });
});
