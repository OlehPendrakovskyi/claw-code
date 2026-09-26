

const createDisposable = () => ({ dispose: jest.fn() });

const createOutputChannel = jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    appendLine: jest.fn(),
    append: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
}));

export const window = {
    createStatusBarItem: jest.fn(() => ({
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn(),
        text: '',
        tooltip: '',
        command: '',
        name: '',
        accessibilityInformation: {},
    })),
    createTreeView: jest.fn(() => createDisposable()),
    registerWebviewViewProvider: jest.fn(() => createDisposable()),
    createWebviewPanel: jest.fn(() => ({
        reveal: jest.fn(),
        onDidDispose: jest.fn(() => createDisposable()),
        dispose: jest.fn(),
        webview: {
            html: '',
            options: {},
            postMessage: jest.fn(),
            onDidReceiveMessage: jest.fn(() => createDisposable()),
        },
    })),
    onDidCloseTerminal: jest.fn(() => createDisposable()),
    onDidChangeActiveTextEditor: jest.fn(() => createDisposable()),
    onDidChangeTextEditorSelection: jest.fn(() => createDisposable()),
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showQuickPick: jest.fn(),
    showInputBox: jest.fn(),
    showOpenDialog: jest.fn(),
    createTerminal: jest.fn(() => ({
        show: jest.fn(),
        sendText: jest.fn(),
        dispose: jest.fn(),
    })),
    activeTextEditor: undefined,
    createOutputChannel,
    tabGroups: { all: [] },
};

export const commands = {
    registerCommand: jest.fn(() => createDisposable()),
    executeCommand: jest.fn(),
};

export const workspace = {
    getConfiguration: jest.fn(() => ({
        get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
        update: jest.fn(),
        inspect: jest.fn(() => undefined),
    })),
    workspaceFolders: undefined,
    fs: {
        readFile: jest.fn(),
        writeFile: jest.fn(),
        stat: jest.fn(),
        createDirectory: jest.fn(),
    },
    openTextDocument: jest.fn(),
    findFiles: jest.fn(() => Promise.resolve([])),
    asRelativePath: jest.fn((p: string) => p),
};

export const languages = {
    onDidChangeDiagnostics: jest.fn(() => createDisposable()),
    getDiagnostics: jest.fn(() => []),
};

export const env = {
    clipboard: { writeText: jest.fn() },
    openExternal: jest.fn(),
};

export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
}

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
}

export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3,
}

export enum ConfigurationTarget {
    Global = 1,
    Workspace = 2,
    WorkspaceFolder = 3,
}

export enum ViewColumn {
    Beside = -2,
}

export class EventEmitter<T> {
    event = jest.fn();
    fire = jest.fn();
    dispose = jest.fn();
}

export class TreeItem {
    label: string;
    collapsibleState: TreeItemCollapsibleState;
    description?: string;
    tooltip?: string;
    iconPath?: unknown;
    command?: unknown;
    constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState ?? TreeItemCollapsibleState.None;
    }
}

export class ThemeIcon {
    id: string;
    constructor(id: string) {
        this.id = id;
    }
}

export class Uri {
    readonly fsPath: string;
    private constructor(fsPath: string) {
        this.fsPath = fsPath;
    }
    static file(p: string) {
        return new Uri(p);
    }
    static parse(s: string) {
        return new Uri(s);
    }
}

export class TabInputText {
    uri: Uri;
    constructor(uri: Uri) {
        this.uri = uri;
    }
}
