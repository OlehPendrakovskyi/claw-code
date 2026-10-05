import * as path from 'path';
import * as vscode from 'vscode';
import { buildRecommendations } from '../webview/recommendations';

// The single-uri overload is the one the code under test calls.
const getDiagnostics = vi.mocked<(uri: vscode.Uri) => vscode.Diagnostic[]>(vscode.languages.getDiagnostics);
const mockWindow = vscode.window as { activeTextEditor: unknown };

const filePath = path.join(path.sep, 'work', 'src', 'app.ts');

function setEditor(options: { selectionEmpty: boolean } | undefined) {
    mockWindow.activeTextEditor = options && {
        selection: { isEmpty: options.selectionEmpty },
        document: { uri: vscode.Uri.file(filePath) },
    };
}

function diagnostics(...severities: vscode.DiagnosticSeverity[]): vscode.Diagnostic[] {
    return severities.map(severity => ({ severity, message: 'm' }) as Partial<vscode.Diagnostic> as vscode.Diagnostic);
}

const commandsOf = (recs: ReturnType<typeof buildRecommendations>) => recs.map(rec => rec.command);
const labelsOf = (recs: ReturnType<typeof buildRecommendations>) => recs.map(rec => rec.label);

describe('buildRecommendations', () => {
    beforeEach(() => {
        getDiagnostics.mockReset().mockReturnValue([]);
        setEditor(undefined);
    });

    afterEach(() => {
        setEditor(undefined);
    });

    it('offers workspace-level actions when no editor is open', () => {
        const recs = buildRecommendations();
        expect(labelsOf(recs)).toEqual(['Review changes', 'Commit message', 'Search codebase', 'Security analysis']);
        expect(commandsOf(recs)).toEqual(['/review', '/commit', '/search', '/harden']);
        expect(getDiagnostics).not.toHaveBeenCalled();
        expect(recs.every(rec => rec.icon.length > 0)).toBe(true);
    });

    it('offers file actions named after the open file when nothing is selected', () => {
        setEditor({ selectionEmpty: true });
        const recs = buildRecommendations();
        expect(labelsOf(recs)).toEqual(['Explain app.ts', 'Review app.ts', 'Document code', 'Security analysis']);
        expect(commandsOf(recs)).toEqual(['/explain', '/review', '/doc', '/harden']);
        expect(getDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ fsPath: filePath }));
    });

    it('offers selection actions when text is selected', () => {
        setEditor({ selectionEmpty: false });
        const recs = buildRecommendations();
        expect(labelsOf(recs)).toEqual([
            'Explain selection', 'Refactor selection', 'Write tests', 'Review app.ts', 'Document code', 'Security analysis',
        ]);
        expect(commandsOf(recs)).toEqual(['/explain', '/refactor', '/test', '/review', '/doc', '/harden']);
    });

    it('counts a single error with the singular noun', () => {
        setEditor({ selectionEmpty: true });
        getDiagnostics.mockReturnValue(diagnostics(vscode.DiagnosticSeverity.Error));
        const fix = buildRecommendations().find(rec => rec.command === '/fix');
        expect(fix?.label).toBe('Fix 1 issue');
    });

    it('counts only errors, pluralised, and places the fix before the review', () => {
        setEditor({ selectionEmpty: false });
        getDiagnostics.mockReturnValue(diagnostics(
            vscode.DiagnosticSeverity.Error,
            vscode.DiagnosticSeverity.Warning,
            vscode.DiagnosticSeverity.Error,
            vscode.DiagnosticSeverity.Hint,
        ));
        const recs = buildRecommendations();
        expect(labelsOf(recs)).toContain('Fix 2 issues');
        expect(commandsOf(recs)).toEqual(['/explain', '/refactor', '/test', '/fix', '/review', '/doc', '/harden']);
    });

    it('offers no fix when there are only warnings', () => {
        setEditor({ selectionEmpty: true });
        getDiagnostics.mockReturnValue(diagnostics(vscode.DiagnosticSeverity.Warning, vscode.DiagnosticSeverity.Information));
        expect(commandsOf(buildRecommendations())).not.toContain('/fix');
    });
});
