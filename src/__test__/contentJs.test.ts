import { SESSIONS_PANEL_JS, TOOL_STATUS_JS } from '../webview/content-js';

type Listener = (event: FakeEvent) => void;
type FakeEvent = { key?: string; target?: unknown; preventDefault(): void; stopPropagation(): void };

/** Just enough DOM for the sessions panel fragment. */
class FakeElement {
    id = '';
    title = '';
    textContent = '';
    style = { cssText: '' };
    parent: FakeElement | null = null;
    readonly children: FakeElement[] = [];
    private readonly attributes = new Map<string, string>();
    private readonly listeners = new Map<string, Listener[]>();

    constructor(readonly tagName: string, private readonly doc: FakeDocument) {}

    setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
    getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
    appendChild(child: FakeElement): FakeElement {
        child.parent = this;
        this.children.push(child);
        return child;
    }
    remove(): void {
        if (this.parent) {
            this.parent.children.splice(this.parent.children.indexOf(this), 1);
            this.parent = null;
        }
    }
    contains(node: unknown): boolean {
        return node === this || this.children.some(child => child.contains(node));
    }
    focus(): void { this.doc.activeElement = this; }
    addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    dispatch(type: string, init: Partial<FakeEvent> = {}): void {
        const event: FakeEvent = { target: this, preventDefault() {}, stopPropagation() {}, ...init };
        (this.listeners.get(type) ?? []).forEach(listener => listener(event));
    }
    find(predicate: (el: FakeElement) => boolean): FakeElement | null {
        if (predicate(this)) {
            return this;
        }
        for (const child of this.children) {
            const found = child.find(predicate);
            if (found) {
                return found;
            }
        }
        return null;
    }
}

class FakeDocument {
    activeElement: FakeElement | null = null;
    readonly body = new FakeElement('body', this);
    readonly buttons = new Map<string, FakeElement>();
    readonly clickListeners = new Set<Listener>();

    createElement(tagName: string): FakeElement { return new FakeElement(tagName, this); }
    getElementById(id: string): FakeElement | null { return this.body.find(el => el.id === id); }
    querySelector(selector: string): FakeElement | null { return this.buttons.get(selector) ?? null; }
    addEventListener(_type: string, listener: Listener): void { this.clickListeners.add(listener); }
    removeEventListener(_type: string, listener: Listener): void { this.clickListeners.delete(listener); }
}

type SessionsPanel = {
    renderSessionsPanel(listing: Record<string, unknown>): void;
    dismissSessionsPanel(options?: { restoreFocus?: boolean }): void;
    requestSessionsPanel(threadId: string): void;
};

function loadSessionsPanel(): { panel: SessionsPanel; doc: FakeDocument; posted: Array<Record<string, unknown>> } {
    const doc = new FakeDocument();
    const posted: Array<Record<string, unknown>> = [];
    const vscode = { postMessage: (message: Record<string, unknown>) => posted.push(message) };
    const panel = new Function('document', 'vscode', 'Node',
        `${SESSIONS_PANEL_JS}; return { renderSessionsPanel, dismissSessionsPanel, requestSessionsPanel };`
    )(doc, vscode, FakeElement) as SessionsPanel;
    return { panel, doc, posted };
}

function loadToolStatus(): {
    getToolGroupStatus(entries: Array<{ status: string }>): string;
    shouldOpenToolGroup(status: string): boolean;
    getToolStatusSymbol(status: string): string;
    getToolStatusClass(status: string): string;
} {
    return new Function(
        `${TOOL_STATUS_JS}; return { getToolGroupStatus, shouldOpenToolGroup, getToolStatusSymbol, getToolStatusClass };`
    )();
}

const SESSIONS = [
    { sessionKey: 'agent:main:main', label: 'Main', hasActiveRun: true },
    { sessionKey: 'agent:coder:main', label: 'Coder', cold: true },
];

function panelOf(doc: FakeDocument): FakeElement {
    const panel = doc.getElementById('claw-sessions-panel');
    expect(panel).not.toBeNull();
    return panel!;
}

function rowsOf(doc: FakeDocument): FakeElement[] {
    return panelOf(doc).children.filter(el => el.getAttribute('role') === 'menuitem');
}

describe('content-js', () => {
    describe('tool status', () => {
        const status = loadToolStatus();

        it('reports running while any entry is non-terminal, even beside a failure', () => {
            expect(status.getToolGroupStatus([{ status: 'error' }, { status: 'running' }])).toBe('running');
        });

        it('reports error, cancelled, then done once every entry is terminal', () => {
            expect(status.getToolGroupStatus([{ status: 'done' }, { status: 'failed' }, { status: 'cancelled' }])).toBe('error');
            expect(status.getToolGroupStatus([{ status: 'done' }, { status: 'cancelled' }])).toBe('cancelled');
            expect(status.getToolGroupStatus([{ status: 'done' }])).toBe('done');
        });

        it('opens running and failed groups only', () => {
            expect(['running', 'error', 'cancelled', 'done'].map(status.shouldOpenToolGroup)).toEqual([true, true, false, false]);
        });

        it('gives each status its own glyph and class', () => {
            expect(['done', 'error', 'cancelled', 'running'].map(status.getToolStatusSymbol)).toEqual(['✓', '✗', '⊘', '⟳']);
            expect(['done', 'failed', 'cancelled', 'pending'].map(status.getToolStatusClass)).toEqual([' tool-ok', ' tool-fail', ' tool-cancel', ' tool-run']);
        });
    });

    describe('sessions panel', () => {
        it('requests sessions for the pane that opened it', () => {
            const { panel, posted } = loadSessionsPanel();
            panel.requestSessionsPanel('thread-2');
            expect(posted).toEqual([{ type: 'requestSessions', threadId: 'thread-2' }]);
        });

        it('renders a labelled menu and focuses the first row', () => {
            const { panel, doc } = loadSessionsPanel();
            panel.renderSessionsPanel({ sessions: SESSIONS, threadId: 'thread-1' });
            expect(panelOf(doc).getAttribute('role')).toBe('menu');
            expect(panelOf(doc).getAttribute('aria-label')).toBe('Sessions');
            expect(rowsOf(doc).map(row => row.textContent)).toEqual(['● Main', '❄ Coder']);
            expect(doc.activeElement).toBe(rowsOf(doc)[0]);
        });

        it('opens a session into the requesting thread', () => {
            const { panel, doc, posted } = loadSessionsPanel();
            panel.requestSessionsPanel('thread-3');
            panel.renderSessionsPanel({ sessions: SESSIONS });
            rowsOf(doc)[1].dispatch('click');
            expect(posted[posted.length - 1]).toEqual({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-3' });
        });

        it('moves focus with the arrow keys, wrapping around', () => {
            const { panel, doc } = loadSessionsPanel();
            panel.renderSessionsPanel({ sessions: SESSIONS, threadId: 'thread-1' });
            panelOf(doc).dispatch('keydown', { key: 'ArrowDown' });
            expect(doc.activeElement).toBe(rowsOf(doc)[1]);
            panelOf(doc).dispatch('keydown', { key: 'ArrowDown' });
            expect(doc.activeElement).toBe(rowsOf(doc)[0]);
            panelOf(doc).dispatch('keydown', { key: 'ArrowUp' });
            expect(doc.activeElement).toBe(rowsOf(doc)[1]);
        });

        it('closes on Escape and returns focus to the Sessions button', () => {
            const { panel, doc } = loadSessionsPanel();
            const button = doc.createElement('button');
            doc.buttons.set('.pane-btn[data-action="sessions"][data-thread-id="thread-1"]', button);
            panel.renderSessionsPanel({ sessions: SESSIONS, threadId: 'thread-1' });
            panelOf(doc).dispatch('keydown', { key: 'Escape' });
            expect(doc.getElementById('claw-sessions-panel')).toBeNull();
            expect(doc.activeElement).toBe(button);
        });

        it('shows an explicit row when the list is empty or unavailable', () => {
            const { panel, doc } = loadSessionsPanel();
            panel.renderSessionsPanel({ sessions: [] });
            expect(rowsOf(doc).map(row => row.textContent)).toEqual(['No sessions']);
            panel.renderSessionsPanel({ sessions: [], error: 'Gateway not connected' });
            expect(rowsOf(doc).map(row => row.textContent)).toEqual(['Gateway not connected']);
            expect(rowsOf(doc)[0].getAttribute('aria-disabled')).toBe('true');
            expect(doc.activeElement).toBe(rowsOf(doc)[0]);
        });

        it('drops its outside-click listener when dismissed', async () => {
            const { panel, doc } = loadSessionsPanel();
            panel.renderSessionsPanel({ sessions: SESSIONS, threadId: 'thread-1' });
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(doc.clickListeners.size).toBe(1);
            panel.dismissSessionsPanel();
            expect(doc.clickListeners.size).toBe(0);
            expect(doc.getElementById('claw-sessions-panel')).toBeNull();
        });
    });
});
