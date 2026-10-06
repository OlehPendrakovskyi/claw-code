import * as vscode from 'vscode';
import { disposeStatusBar, formatStatusText, initStatusBar, setStatus, STATUS_LABEL } from '../vscode/statusbar';

const createStatusBarItem = vi.mocked(vscode.window.createStatusBarItem);

describe('status bar', () => {
    afterEach(() => {
        disposeStatusBar();
    });

    it('formatStatusText prefixes the label with the icon', () => {
        expect(formatStatusText('$(plug)')).toBe(`$(plug) ${STATUS_LABEL}`);
    });

    it('initStatusBar creates a right-aligned item that runs the connect command', () => {
        createStatusBarItem.mockClear();
        const item = initStatusBar();
        expect(createStatusBarItem).toHaveBeenCalledWith(vscode.StatusBarAlignment.Right, 100);
        expect(item.command).toBe('openclaw.connect');
        expect(item.name).toBe('OpenClaw');
        expect(item.accessibilityInformation).toEqual({ label: 'OpenClaw', role: 'button' });
    });

    it.each([
        ['idle', '$(plug) OpenClaw', 'Click to connect to OpenClaw'],
        ['connecting', '$(sync~spin) OpenClaw', 'Connection in progress'],
        ['connected', '$(check) OpenClaw', 'OpenClaw command sent'],
        ['error', '$(alert) OpenClaw', 'Connection failed. Click to retry.'],
    ] as const)('setStatus(%s) shows %s', (state, text, tooltip) => {
        const item = initStatusBar();
        setStatus(state);
        expect(item.text).toBe(text);
        expect(item.tooltip).toBe(tooltip);
    });

    it('an unknown state falls back to idle', () => {
        const item = initStatusBar();
        setStatus('error');
        setStatus('bogus' as Parameters<typeof setStatus>[0]);
        expect(item.text).toBe('$(plug) OpenClaw');
    });

    it('disposeStatusBar disposes the item, after which setStatus is a no-op', () => {
        const item = initStatusBar();
        setStatus('connected');
        disposeStatusBar();
        expect(item.dispose).toHaveBeenCalledTimes(1);
        setStatus('error');
        expect(item.text).toBe('$(check) OpenClaw');
        expect(() => disposeStatusBar()).not.toThrow();
        expect(item.dispose).toHaveBeenCalledTimes(1);
    });

    it('setStatus before init does nothing', () => {
        expect(() => setStatus('connecting')).not.toThrow();
    });
});
