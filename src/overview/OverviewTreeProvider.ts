import * as vscode from 'vscode';
import { OPENCLAW_DASHBOARD_URL } from '../core/constants';
import { getHardeningMode } from '../core/configIO';
import { loadToolsForOverview, type ToolEntry } from '../core/tools';
import type { AccessSummary } from '../core/accessInfo';

class OverviewItem extends vscode.TreeItem {
    readonly children?: OverviewItem[];

    constructor(
        label: string,
        options: {
            description?: string;
            tooltip?: string;
            icon?: vscode.ThemeIcon;
            command?: vscode.Command;
            children?: OverviewItem[];
            collapsibleState?: vscode.TreeItemCollapsibleState;
        } = {}
    ) {
        const collapsibleState =
            options.collapsibleState ??
            (options.children && options.children.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None);
        super(label, collapsibleState);
        this.description = options.description;
        this.tooltip = options.tooltip;
        this.iconPath = options.icon;
        this.command = options.command;
        this.children = options.children;
    }
}

export class OverviewTreeProvider implements vscode.TreeDataProvider<OverviewItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<OverviewItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private lastRun: Date | undefined;
    private accessSummary: AccessSummary | undefined;
    private toolEntries: ToolEntry[] = [];
    private toolsError: string | undefined;

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    async refreshTools() {
        const { entries, error } = await loadToolsForOverview();
        this.toolEntries = entries;
        this.toolsError = error;
        this.refresh();
    }

    setLastRun(date: Date) {
        this.lastRun = date;
        this.refresh();
    }

    setAccessSummary(summary: AccessSummary) {
        this.accessSummary = summary;
        this.refresh();
    }

    getTreeItem(element: OverviewItem) {
        return element;
    }

    getChildren(element?: OverviewItem) {
        if (element) {
            return element.children ?? [];
        }
        return [
            this.buildGettingStartedSection(),
            this.buildOperateSection(),
            this.buildHardeningSection(),
            this.buildToolsSection(),
            this.buildHelpSection()
        ];
    }

    private buildGettingStartedSection() {
        return new OverviewItem('Getting Started', {
            icon: new vscode.ThemeIcon('rocket'),
            collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
            children: [
                new OverviewItem('Connect', {
                    description: 'Run your OpenClaw command',
                    icon: new vscode.ThemeIcon('plug'),
                    command: {
                        command: 'openclaw.connect',
                        title: 'OpenClaw Connect'
                    }
                }),
                new OverviewItem('Setup', {
                    description: 'Install Node + OpenClaw',
                    icon: new vscode.ThemeIcon('tools'),
                    command: {
                        command: 'openclaw.setup',
                        title: 'OpenClaw Setup'
                    }
                }),
                new OverviewItem('Model Setup Wizard', {
                    description: 'Onboard + choose provider',
                    icon: new vscode.ThemeIcon('settings-gear'),
                    command: {
                        command: 'openclaw.modelSetup',
                        title: 'OpenClaw Model Setup Wizard'
                    }
                })
            ]
        });
    }

    private buildOperateSection() {
        return new OverviewItem('Operate', {
            icon: new vscode.ThemeIcon('dashboard'),
            children: [
                new OverviewItem('Run status', {
                    description: 'Check gateway + agent status',
                    icon: new vscode.ThemeIcon('terminal'),
                    command: {
                        command: 'openclaw.hardening.runStatus',
                        title: 'Run OpenClaw status'
                    }
                }),
                new OverviewItem('Run doctor', {
                    description: 'Health checks + quick fixes',
                    icon: new vscode.ThemeIcon('stethoscope'),
                    command: {
                        command: 'openclaw.doctor',
                        title: 'Run OpenClaw doctor'
                    }
                }),
                new OverviewItem('Update OpenClaw', {
                    description: 'Fetch latest version + restart',
                    icon: new vscode.ThemeIcon('cloud-download'),
                    command: {
                        command: 'openclaw.update',
                        title: 'Update OpenClaw'
                    }
                }),
                new OverviewItem('Reconfigure', {
                    description: 'Re-run guided configuration',
                    icon: new vscode.ThemeIcon('settings-gear'),
                    command: {
                        command: 'openclaw.configure',
                        title: 'Reconfigure OpenClaw'
                    }
                }),
                new OverviewItem('Open dashboard', {
                    description: OPENCLAW_DASHBOARD_URL,
                    icon: new vscode.ThemeIcon('globe'),
                    command: {
                        command: 'openclaw.hardening.openDashboard',
                        title: 'Open OpenClaw dashboard'
                    }
                }),
                new OverviewItem('Open config', {
                    description: '~/.openclaw/openclaw.json',
                    icon: new vscode.ThemeIcon('file'),
                    command: {
                        command: 'openclaw.hardening.openConfig',
                        title: 'Open OpenClaw config'
                    }
                })
            ]
        });
    }

    private buildHardeningSection() {
        const accessSummaryTooltip = this.accessSummary
            ? `Generated ${this.accessSummary.generatedAt.toLocaleString()}`
            : 'Generate a plain-English access summary';
        const mode = getHardeningMode();
        const modeLabel = mode === 'full' ? 'Audit / Fix / Deep' : mode === 'auditFix' ? 'Audit / Fix' : 'Audit';
        const lastRunTooltip = this.lastRun ? `Last run ${this.lastRun.toLocaleString()}` : undefined;

        return new OverviewItem('Hardening', {
            icon: new vscode.ThemeIcon('shield'),
            children: [
                new OverviewItem('Run hardening', {
                    description: modeLabel,
                    tooltip: lastRunTooltip ?? 'Run the configured OpenClaw hardening workflow',
                    icon: new vscode.ThemeIcon('shield'),
                    command: {
                        command: 'openclaw.harden',
                        title: 'Run OpenClaw hardening'
                    }
                }),
                new OverviewItem('Access summary', {
                    description: 'Plain-English permissions',
                    tooltip: accessSummaryTooltip,
                    icon: new vscode.ThemeIcon('list-unordered'),
                    command: {
                        command: 'openclaw.hardening.showAccessSummary',
                        title: 'Show OpenClaw access summary'
                    }
                }),
                new OverviewItem('Open security docs', {
                    description: 'docs.openclaw.ai/gateway/security',
                    icon: new vscode.ThemeIcon('book'),
                    command: {
                        command: 'openclaw.hardening.openDocs',
                        title: 'Open OpenClaw security docs'
                    }
                })
            ]
        });
    }

    private buildToolsSection() {
        const children: OverviewItem[] = [];

        if (this.toolsError) {
            children.push(
                new OverviewItem('Config issue', {
                    description: this.toolsError,
                    icon: new vscode.ThemeIcon('warning')
                })
            );
        }

        if (this.toolEntries.length === 0) {
            children.push(
                new OverviewItem('No tools found', {
                    description: 'Add tools in ~/.openclaw/openclaw.json',
                    icon: new vscode.ThemeIcon('circle-slash')
                })
            );
        }

        for (const tool of this.toolEntries) {
            const toggleLabel = tool.enabled ? 'Disable' : 'Enable';
            const toggleIcon = tool.enabled ? new vscode.ThemeIcon('circle-slash') : new vscode.ThemeIcon('plug');
            const tooltipParts = [];
            if (tool.description) {
                tooltipParts.push(tool.description);
            }
            tooltipParts.push(`Source: ${tool.source}`);
            const toolItem = new OverviewItem(tool.label, {
                description: tool.enabled ? 'Enabled' : 'Disabled',
                tooltip: tooltipParts.join('\n'),
                icon: tool.enabled ? new vscode.ThemeIcon('plug') : new vscode.ThemeIcon('circle-slash'),
                children: [
                    new OverviewItem(toggleLabel, {
                        description: `${toggleLabel} this tool`,
                        icon: toggleIcon,
                        command: {
                            command: 'openclaw.tools.toggle',
                            title: `${toggleLabel} tool`,
                            arguments: [tool]
                        }
                    }),
                    new OverviewItem('Uninstall', {
                        description: 'Remove from config',
                        icon: new vscode.ThemeIcon('trash'),
                        command: {
                            command: 'openclaw.tools.uninstall',
                            title: 'Uninstall tool',
                            arguments: [tool]
                        }
                    })
                ]
            });
            children.push(toolItem);
        }

        children.push(
            new OverviewItem('Refresh tools', {
                description: 'Reload tools from config',
                icon: new vscode.ThemeIcon('refresh'),
                command: {
                    command: 'openclaw.tools.refresh',
                    title: 'Refresh tools'
                }
            })
        );

        return new OverviewItem('Tools', {
            icon: new vscode.ThemeIcon('wrench'),
            children
        });
    }

    private buildHelpSection() {
        return new OverviewItem('Help', {
            icon: new vscode.ThemeIcon('question'),
            children: [
                new OverviewItem('Open docs', {
                    description: 'docs.openclaw.ai',
                    icon: new vscode.ThemeIcon('book'),
                    command: {
                        command: 'openclaw.openDocs',
                        title: 'Open OpenClaw docs'
                    }
                }),
                new OverviewItem('Refresh view', {
                    description: 'Reload items',
                    icon: new vscode.ThemeIcon('refresh'),
                    command: {
                        command: 'openclaw.hardening.refresh',
                        title: 'Refresh OpenClaw view'
                    }
                })
            ]
        });
    }
}
