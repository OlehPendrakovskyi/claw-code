import * as vscode from 'vscode';
import {
    disposeTerminals,
    forgetTerminal,
    getHardeningTerminal,
    getOpenClawTerminal,
    getOverviewProvider,
    getSetupTerminal,
    setOverviewProvider,
} from '../vscode/commands/terminals';
import { OverviewTreeProvider } from '../overview/OverviewTreeProvider';

const createTerminal = vi.mocked(vscode.window.createTerminal);

function fakeTerminal(name: string): vscode.Terminal {
    return { name, show: vi.fn(), sendText: vi.fn(), dispose: vi.fn() } as Partial<vscode.Terminal> as vscode.Terminal;
}

const getters = [
    ['getOpenClawTerminal', getOpenClawTerminal, 'OpenClaw'],
    ['getSetupTerminal', getSetupTerminal, 'OpenClaw Setup'],
    ['getHardeningTerminal', getHardeningTerminal, 'OpenClaw Hardening'],
] as const;

describe('terminals', () => {
    beforeEach(() => {
        disposeTerminals();
        createTerminal.mockReset().mockImplementation((nameOrOptions?: string | vscode.TerminalOptions | vscode.ExtensionTerminalOptions) =>
            fakeTerminal(typeof nameOrOptions === 'string' ? nameOrOptions : 'unnamed'));
    });

    afterEach(() => {
        disposeTerminals();
        setOverviewProvider(undefined);
    });

    describe.each(getters)('%s', (_name, get, title) => {
        it(`creates a terminal named ${title} on first use`, () => {
            const created = get();
            expect(createTerminal).toHaveBeenCalledTimes(1);
            expect(createTerminal).toHaveBeenCalledWith(title);
            expect(created.name).toBe(title);
        });

        it('reuses the same terminal on later calls', () => {
            const first = get();
            expect(get()).toBe(first);
            expect(createTerminal).toHaveBeenCalledTimes(1);
        });

        it('creates a fresh terminal after the old one was closed', () => {
            const first = get();
            forgetTerminal(first);
            const second = get();
            expect(second).not.toBe(first);
            expect(createTerminal).toHaveBeenCalledTimes(2);
            expect(first.dispose).not.toHaveBeenCalled();
        });
    });

    it('keeps the three terminals distinct', () => {
        const main = getOpenClawTerminal();
        const setup = getSetupTerminal();
        const hardening = getHardeningTerminal();
        expect(new Set([main, setup, hardening]).size).toBe(3);
        expect(createTerminal.mock.calls.map(call => call[0])).toEqual(['OpenClaw', 'OpenClaw Setup', 'OpenClaw Hardening']);
    });

    describe('forgetTerminal', () => {
        it('reports true only for the main terminal', () => {
            const main = getOpenClawTerminal();
            const setup = getSetupTerminal();
            const hardening = getHardeningTerminal();
            expect(forgetTerminal(setup)).toBe(false);
            expect(forgetTerminal(hardening)).toBe(false);
            expect(forgetTerminal(main)).toBe(true);
            // Already forgotten: a second close of the same terminal is not the main one any more.
            expect(forgetTerminal(main)).toBe(false);
        });

        it('leaves the managed terminals alone when an unrelated terminal closes', () => {
            const main = getOpenClawTerminal();
            const setup = getSetupTerminal();
            const hardening = getHardeningTerminal();
            expect(forgetTerminal(fakeTerminal('user shell'))).toBe(false);
            expect(getOpenClawTerminal()).toBe(main);
            expect(getSetupTerminal()).toBe(setup);
            expect(getHardeningTerminal()).toBe(hardening);
            expect(createTerminal).toHaveBeenCalledTimes(3);
        });

        it('returns false when no terminal has been created', () => {
            expect(forgetTerminal(fakeTerminal('user shell'))).toBe(false);
        });
    });

    describe('disposeTerminals', () => {
        it('disposes every created terminal and the next call creates new ones', () => {
            const before = [getOpenClawTerminal(), getSetupTerminal(), getHardeningTerminal()];
            disposeTerminals();
            for (const terminal of before) {
                expect(terminal.dispose).toHaveBeenCalledTimes(1);
            }
            const after = [getOpenClawTerminal(), getSetupTerminal(), getHardeningTerminal()];
            after.forEach((terminal, index) => {
                expect(terminal).not.toBe(before[index]);
            });
            expect(createTerminal).toHaveBeenCalledTimes(6);
        });

        it('is a no-op when nothing was created, and does not dispose twice', () => {
            expect(() => disposeTerminals()).not.toThrow();
            const main = getOpenClawTerminal();
            disposeTerminals();
            disposeTerminals();
            expect(main.dispose).toHaveBeenCalledTimes(1);
        });
    });

    describe('overview provider registry', () => {
        it('is empty until a provider is registered', () => {
            expect(getOverviewProvider()).toBeUndefined();
        });

        it('returns the registered provider and can be cleared', () => {
            const provider = new OverviewTreeProvider();
            setOverviewProvider(provider);
            expect(getOverviewProvider()).toBe(provider);
            setOverviewProvider(undefined);
            expect(getOverviewProvider()).toBeUndefined();
        });
    });
});
