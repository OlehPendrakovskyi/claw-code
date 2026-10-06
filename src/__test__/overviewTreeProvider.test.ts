import * as vscode from 'vscode';
import { OverviewTreeProvider } from '../overview/OverviewTreeProvider';
import { getHardeningMode } from '../core/configIO';
import { getDashboardUrl } from '../vscode/config';
import { loadToolsForOverview, type ToolEntry } from '../core/tools';

vi.mock('../core/configIO', async () => ({
    ...(await vi.importActual<typeof import('../core/configIO')>('../core/configIO')),
    getHardeningMode: vi.fn(() => 'full' as const),
} satisfies Partial<typeof import('../core/configIO')>));

vi.mock('../vscode/config', async () => ({
    ...(await vi.importActual<typeof import('../vscode/config')>('../vscode/config')),
    getDashboardUrl: vi.fn(() => 'http://127.0.0.1:18789/'),
} satisfies Partial<typeof import('../vscode/config')>));

vi.mock('../core/tools', async () => ({
    ...(await vi.importActual<typeof import('../core/tools')>('../core/tools')),
    loadToolsForOverview: vi.fn(() => Promise.resolve({ entries: [] })),
} satisfies Partial<typeof import('../core/tools')>));

const hardeningMode = vi.mocked(getHardeningMode);
const dashboardUrl = vi.mocked(getDashboardUrl);
const loadTools = vi.mocked(loadToolsForOverview);

type Item = ReturnType<OverviewTreeProvider['getChildren']>[number];

function iconId(item: Item): string | undefined {
    return item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : undefined;
}

function section(provider: OverviewTreeProvider, label: string): Item {
    const found = provider.getChildren().find(item => item.label === label);
    if (!found) {
        throw new Error(`section ${label} missing`);
    }
    return found;
}

function child(parent: Item, label: string): Item {
    const found = parent.children?.find(item => item.label === label);
    if (!found) {
        throw new Error(`child ${label} missing`);
    }
    return found;
}

function commandOf(item: Item): string | undefined {
    return item.command?.command;
}

const tool = (overrides: Partial<ToolEntry> = {}): ToolEntry => ({
    id: 'web',
    label: 'Web search',
    enabled: true,
    path: ['tools', 'web'],
    source: 'tools.web',
    ...overrides,
});

describe('OverviewTreeProvider', () => {
    let provider: OverviewTreeProvider;
    let fire: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        hardeningMode.mockReset().mockReturnValue('full');
        dashboardUrl.mockReset().mockReturnValue('http://127.0.0.1:18789/');
        loadTools.mockReset().mockResolvedValue({ entries: [] });
        provider = new OverviewTreeProvider();
        fire = vi.mocked(provider['_onDidChangeTreeData'].fire);
    });

    describe('root sections', () => {
        it('lists the five sections in order, only Getting Started expanded', () => {
            const roots = provider.getChildren();
            expect(roots.map(item => item.label)).toEqual(['Getting Started', 'Operate', 'Hardening', 'Tools', 'Help']);
            expect(roots.map(item => item.collapsibleState)).toEqual([
                vscode.TreeItemCollapsibleState.Expanded,
                vscode.TreeItemCollapsibleState.Collapsed,
                vscode.TreeItemCollapsibleState.Collapsed,
                vscode.TreeItemCollapsibleState.Collapsed,
                vscode.TreeItemCollapsibleState.Collapsed,
            ]);
            expect(roots.map(iconId)).toEqual(['rocket', 'dashboard', 'shield', 'wrench', 'question']);
            expect(roots.every(item => item.command === undefined)).toBe(true);
        });

        it('getTreeItem returns the element itself and getChildren of a node returns its children', () => {
            const help = section(provider, 'Help');
            expect(provider.getTreeItem(help)).toBe(help);
            expect(provider.getChildren(help)).toBe(help.children);
        });

        it('a leaf has no children and is not collapsible', () => {
            const connect = child(section(provider, 'Getting Started'), 'Connect');
            expect(provider.getChildren(connect)).toEqual([]);
            expect(connect.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
        });

        it.each([
            ['Getting Started', [
                ['Connect', 'openclaw.connect'],
                ['Setup', 'openclaw.setup'],
                ['Model Setup Wizard', 'openclaw.modelSetup'],
            ]],
            ['Operate', [
                ['Run status', 'openclaw.hardening.runStatus'],
                ['Run doctor', 'openclaw.doctor'],
                ['Update OpenClaw', 'openclaw.update'],
                ['Reconfigure', 'openclaw.configure'],
                ['Open dashboard', 'openclaw.hardening.openDashboard'],
                ['Open config', 'openclaw.hardening.openConfig'],
            ]],
            ['Hardening', [
                ['Run hardening', 'openclaw.harden'],
                ['Access summary', 'openclaw.hardening.showAccessSummary'],
                ['Open security docs', 'openclaw.hardening.openDocs'],
            ]],
            ['Help', [
                ['Open docs', 'openclaw.openDocs'],
                ['Refresh view', 'openclaw.hardening.refresh'],
            ]],
        ])('%s binds each item to its command', (label, expected) => {
            const items = section(provider, label).children ?? [];
            expect(items.map(item => [item.label, commandOf(item)])).toEqual(expected);
            expect(items.every(item => typeof item.command?.title === 'string' && item.command.title.length > 0)).toBe(true);
        });
    });

    describe('Operate', () => {
        it('shows the dashboard URL as the description', () => {
            expect(child(section(provider, 'Operate'), 'Open dashboard').description).toBe('http://127.0.0.1:18789/');
        });

        it('redacts credentials in the dashboard URL', () => {
            dashboardUrl.mockReturnValue('https://user:pw@gw.example.net/?token=abc');
            const description = String(child(section(provider, 'Operate'), 'Open dashboard').description);
            expect(description).not.toContain('pw');
            expect(description).not.toContain('abc');
            expect(description).toContain('gw.example.net');
        });
    });

    describe('Hardening', () => {
        it.each([
            ['full', 'Audit / Fix / Deep'],
            ['auditFix', 'Audit / Fix'],
            ['audit', 'Audit'],
        ] as const)('labels the %s mode as %s', (mode, label) => {
            hardeningMode.mockReturnValue(mode);
            expect(child(section(provider, 'Hardening'), 'Run hardening').description).toBe(label);
        });

        it('uses default tooltips before any run or summary', () => {
            const hardening = section(provider, 'Hardening');
            expect(child(hardening, 'Run hardening').tooltip).toBe('Run the configured OpenClaw hardening workflow');
            expect(child(hardening, 'Access summary').tooltip).toBe('Generate a plain-English access summary');
        });

        it('setLastRun records the run in the tooltip and refreshes the view', () => {
            const when = new Date(2026, 0, 2, 3, 4, 5);
            provider.setLastRun(when);
            expect(fire).toHaveBeenCalledTimes(1);
            expect(child(section(provider, 'Hardening'), 'Run hardening').tooltip).toBe(`Last run ${when.toLocaleString()}`);
        });

        it('setAccessSummary records the generation time in the tooltip and refreshes the view', () => {
            const when = new Date(2026, 5, 6, 7, 8, 9);
            provider.setAccessSummary({ short: 's', markdown: 'm', generatedAt: when });
            expect(fire).toHaveBeenCalledTimes(1);
            expect(child(section(provider, 'Hardening'), 'Access summary').tooltip).toBe(`Generated ${when.toLocaleString()}`);
        });
    });

    describe('Tools', () => {
        it('shows a placeholder and the refresh action when no tools are loaded', () => {
            const tools = section(provider, 'Tools');
            expect(tools.children?.map(item => item.label)).toEqual(['No tools found', 'Refresh tools']);
            expect(commandOf(child(tools, 'No tools found'))).toBeUndefined();
            expect(commandOf(child(tools, 'Refresh tools'))).toBe('openclaw.tools.refresh');
        });

        it('refreshTools loads the tools from config and refreshes the view', async () => {
            loadTools.mockResolvedValue({ entries: [tool()] });
            await provider.refreshTools();
            expect(loadTools).toHaveBeenCalledTimes(1);
            expect(fire).toHaveBeenCalledTimes(1);
            expect(section(provider, 'Tools').children?.map(item => item.label)).toEqual(['Web search', 'Refresh tools']);
        });

        it('shows the config error alongside the placeholder', async () => {
            loadTools.mockResolvedValue({ entries: [], error: 'Invalid JSON' });
            await provider.refreshTools();
            const tools = section(provider, 'Tools');
            expect(tools.children?.map(item => item.label)).toEqual(['Config issue', 'No tools found', 'Refresh tools']);
            const issue = child(tools, 'Config issue');
            expect(issue.description).toBe('Invalid JSON');
            expect(iconId(issue)).toBe('warning');
        });

        it('shows the config error alongside loaded tools without the placeholder', async () => {
            loadTools.mockResolvedValue({ entries: [tool()], error: 'partial' });
            await provider.refreshTools();
            expect(section(provider, 'Tools').children?.map(item => item.label)).toEqual(['Config issue', 'Web search', 'Refresh tools']);
        });

        it('an enabled tool offers Disable and Uninstall bound to that tool', async () => {
            const entry = tool({ description: 'Searches the web' });
            loadTools.mockResolvedValue({ entries: [entry] });
            await provider.refreshTools();
            const item = child(section(provider, 'Tools'), 'Web search');
            expect(item.description).toBe('Enabled');
            expect(item.tooltip).toBe('Searches the web\nSource: tools.web');
            expect(iconId(item)).toBe('plug');
            expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);

            const [toggle, uninstall] = item.children ?? [];
            expect(toggle.label).toBe('Disable');
            expect(toggle.description).toBe('Disable this tool');
            expect(iconId(toggle)).toBe('circle-slash');
            expect(toggle.command).toEqual({ command: 'openclaw.tools.toggle', title: 'Disable tool', arguments: [entry] });
            expect(uninstall.label).toBe('Uninstall');
            expect(uninstall.command).toEqual({ command: 'openclaw.tools.uninstall', title: 'Uninstall tool', arguments: [entry] });
        });

        it('a disabled tool without a description offers Enable', async () => {
            const entry = tool({ id: 'shell', label: 'Shell', enabled: false, source: 'plugins.shell' });
            loadTools.mockResolvedValue({ entries: [entry] });
            await provider.refreshTools();
            const item = child(section(provider, 'Tools'), 'Shell');
            expect(item.description).toBe('Disabled');
            expect(item.tooltip).toBe('Source: plugins.shell');
            expect(iconId(item)).toBe('circle-slash');

            const toggle = child(item, 'Enable');
            expect(toggle.description).toBe('Enable this tool');
            expect(iconId(toggle)).toBe('plug');
            expect(toggle.command).toEqual({ command: 'openclaw.tools.toggle', title: 'Enable tool', arguments: [entry] });
        });

        it('a later refresh replaces the earlier tools and clears the error', async () => {
            loadTools.mockResolvedValueOnce({ entries: [tool()], error: 'old' });
            await provider.refreshTools();
            loadTools.mockResolvedValueOnce({ entries: [] });
            await provider.refreshTools();
            expect(section(provider, 'Tools').children?.map(item => item.label)).toEqual(['No tools found', 'Refresh tools']);
        });
    });

    it('refresh fires a whole-tree change', () => {
        provider.refresh();
        expect(fire).toHaveBeenCalledWith();
        expect(provider.onDidChangeTreeData).toBe(provider['_onDidChangeTreeData'].event);
    });
});
