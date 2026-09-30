

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
            cspSource: 'vscode-webview:',
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

type MockWorkspaceFolder = { name?: string; uri: { fsPath: string } };

function workspaceFolderList(): MockWorkspaceFolder[] | undefined {
    return workspace.workspaceFolders;
}

export const workspace = {
    getConfiguration: jest.fn(() => ({
        get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
        update: jest.fn(),
        inspect: jest.fn(() => undefined),
    })),
    workspaceFolders: undefined as MockWorkspaceFolder[] | undefined,
    /** The innermost folder holding the uri, like VS Code's. */
    getWorkspaceFolder: jest.fn((uri: { fsPath: string }): MockWorkspaceFolder | undefined =>
        [...(workspaceFolderList() ?? [])]
            .filter(folder => uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(`${folder.uri.fsPath}/`))
            .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0]),
    onDidChangeConfiguration: jest.fn(() => createDisposable()),
    onDidGrantWorkspaceTrust: jest.fn(() => createDisposable()),
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

export enum FileType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64,
}

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
    readonly scheme: string;
    private constructor(fsPath: string, scheme: string) {
        this.fsPath = fsPath;
        this.scheme = scheme;
    }
    static file(p: string) {
        return new Uri(p, 'file');
    }
    static parse(s: string) {
        return new Uri(s, /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1] ?? 'file');
    }
    get path(): string {
        return this.fsPath;
    }
    /** Distinct per location like the real Uri, so URI-keyed maps don't collide. */
    toString(): string {
        return this.scheme === 'file' ? `file://${this.fsPath}` : this.fsPath;
    }
}

export class TabInputText {
    uri: Uri;
    constructor(uri: Uri) {
        this.uri = uri;
    }
}

/** Mirrors vscode.FileSystemError: `code` is the factory name, e.g. 'FileNotFound'. */
export class FileSystemError extends Error {
    readonly code: string;
    private constructor(message: string, code: string) {
        super(message);
        this.code = code;
    }
    static FileNotFound(target?: unknown) {
        return new FileSystemError(`File not found: ${String(target ?? '')}`, 'FileNotFound');
    }
    static NoPermissions(target?: unknown) {
        return new FileSystemError(`No permissions: ${String(target ?? '')}`, 'NoPermissions');
    }
}
