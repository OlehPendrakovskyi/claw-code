import * as vscode from 'vscode';
import * as path from 'path';

export interface Recommendation {
    label: string;
    command: string;
    icon: string;
}

export function buildRecommendations(): Recommendation[] {
    const editor = vscode.window.activeTextEditor;
    const recs: Recommendation[] = [];

    if (editor) {
        const hasSelection = !editor.selection.isEmpty;
        const fileName = path.basename(editor.document.uri.fsPath);
        const diags = vscode.languages.getDiagnostics(editor.document.uri);
        const errorCount = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;

        if (hasSelection) {
            recs.push(
                { label: 'Explain selection', command: '/explain', icon: '\u{1F4A1}' },
                { label: 'Refactor selection', command: '/refactor', icon: '\u{21BB}' },
                { label: 'Write tests', command: '/test', icon: '\u2713' },
            );
        } else {
            recs.push(
                { label: `Explain ${fileName}`, command: '/explain', icon: '\u{1F4A1}' },
            );
        }

        if (errorCount > 0) {
            recs.push({
                label: `Fix ${errorCount} issue${errorCount > 1 ? 's' : ''}`,
                command: '/fix',
                icon: '\u{1F527}',
            });
        }

        recs.push(
            { label: `Review ${fileName}`, command: '/review', icon: '\u{1F50D}' },
            { label: 'Document code', command: '/doc', icon: '\u{1F4DD}' },
        );
    } else {
        recs.push(
            { label: 'Review changes', command: '/review', icon: '\u{1F50D}' },
            { label: 'Commit message', command: '/commit', icon: '\u{1F4E6}' },
            { label: 'Search codebase', command: '/search', icon: '\u{1F50E}' },
        );
    }

    recs.push(
        { label: 'Security analysis', command: '/harden', icon: '\u{1F6E1}' },
    );

    return recs;
}