

const createDisposable = () => ({ dispose: vi.fn() });

const createOutputChannel = vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
}));

export const window = {
    createStatusBarItem: vi.fn(() => ({
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
        text: '',
        tooltip: '',
        command: '',
        name: '',
        accessibilityInformation: {},
    })),
    createTreeView: vi.fn(() => createDisposable()),
    registerWebviewViewProvider: vi.fn(() => createDisposable()),
    createWebviewPanel: vi.fn(() => ({
        reveal: vi.fn(),
        onDidDispose: vi.fn(() => createDisposable()),
        dispose: vi.fn(),
        webview: {
            html: '',
            options: {},
            cspSource: 'vscode-webview:',
            postMessage: vi.fn(),
            onDidReceiveMessage: vi.fn(() => createDisposable()),
        },
    })),
    onDidCloseTerminal: vi.fn(() => createDisposable()),
    onDidChangeActiveTextEditor: vi.fn(() => createDisposable()),
    onDidChangeTextEditorSelection: vi.fn(() => createDisposable()),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    createTerminal: vi.fn(() => ({
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
    })),
    activeTextEditor: undefined,
    createOutputChannel,
    tabGroups: { all: [] },
};

export const commands = {
    registerCommand: vi.fn(() => createDisposable()),
    executeCommand: vi.fn(),
};

type MockWorkspaceFolder = { name?: string; uri: { fsPath: string } };

function workspaceFolderList(): MockWorkspaceFolder[] | undefined {
    return workspace.workspaceFolders;
}

export const workspace = {
    getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
        update: vi.fn(),
        inspect: vi.fn(() => undefined),
    })),
    workspaceFolders: undefined as MockWorkspaceFolder[] | undefined,
    /** The innermost folder holding the uri, like VS Code's. */
    getWorkspaceFolder: vi.fn((uri: { fsPath: string }): MockWorkspaceFolder | undefined =>
        [...(workspaceFolderList() ?? [])]
            .filter(folder => uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(`${folder.uri.fsPath}/`))
            .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0]),
    onDidChangeConfiguration: vi.fn(() => createDisposable()),
    onDidGrantWorkspaceTrust: vi.fn(() => createDisposable()),
    fs: {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        stat: vi.fn(),
        createDirectory: vi.fn(),
    },
    openTextDocument: vi.fn(),
    findFiles: vi.fn(() => Promise.resolve([])),
    asRelativePath: vi.fn((p: string) => p),
};

export const languages = {
    onDidChangeDiagnostics: vi.fn(() => createDisposable()),
    getDiagnostics: vi.fn(() => []),
};

export const env = {
    clipboard: { writeText: vi.fn() },
    openExternal: vi.fn(),
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
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
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
    /** Like VS Code's, the target is a message or a Uri, rendered through its own toString(). */
    static FileNotFound(target?: string | { toString(): string }) {
        return new FileSystemError(`File not found: ${target?.toString() ?? ''}`, 'FileNotFound');
    }
    static NoPermissions(target?: string | { toString(): string }) {
        return new FileSystemError(`No permissions: ${target?.toString() ?? ''}`, 'NoPermissions');
    }
}
