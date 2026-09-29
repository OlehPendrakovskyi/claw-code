import * as vscode from 'vscode';
import { getWebviewContent } from '../webview/content';
import { CONTENT_CSS } from '../webview/content-css';
import { CONTENT_JS } from '../webview/content-js';

const CSP_SOURCE = 'https://*.vscode-cdn.net';

function renderHTML(isSidebar = true): string {
    return getWebviewContent({ cspSource: CSP_SOURCE } as vscode.Webview, vscode.Uri.file('/tmp/test-ext'), isSidebar);
}

function cspDirectives(html: string): Map<string, string[]> {
    const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1] ?? '';
    return new Map(policy.split(';').map(part => part.trim()).filter(Boolean).map(part => {
        const [name, ...sources] = part.split(/\s+/);
        return [name, sources];
    }));
}

function nonceOf(html: string, tag: 'script' | 'style'): string | undefined {
    return html.match(new RegExp(`<${tag} nonce="([0-9a-f]+)">`))?.[1];
}

describe('getWebviewContent', () => {
    describe('CSP', () => {
        it('allows only nonce-tagged scripts and styles and webview-resource images', () => {
            const html = renderHTML();
            const nonce = nonceOf(html, 'script');
            expect(Object.fromEntries(cspDirectives(html))).toEqual({
                'default-src': ["'none'"],
                'img-src': [CSP_SOURCE],
                'style-src': [`'nonce-${nonce}'`],
                'script-src': [`'nonce-${nonce}'`],
            });
            expect(html).not.toMatch(/unsafe-(inline|eval|hashes)/);
        });

        it('tags the one script and the one style with the policy nonce', () => {
            const html = renderHTML();
            expect(html.match(/<script\b/g)).toHaveLength(1);
            expect(html.match(/<style\b/g)).toHaveLength(1);
            expect(nonceOf(html, 'style')).toBe(nonceOf(html, 'script'));
            expect(nonceOf(html, 'script')).toMatch(/^[0-9a-f]{32}$/);
        });

        it('draws a fresh nonce for every render', () => {
            expect(nonceOf(renderHTML(), 'script')).not.toBe(nonceOf(renderHTML(), 'script'));
        });

        it('keeps inline event handlers and style attributes out of the static markup', () => {
            const markup = renderHTML().replace(/<script[\s\S]*<\/script>/, '').replace(/<style[\s\S]*<\/style>/, '');
            expect(markup).not.toMatch(/\son[a-z]+=/i);
            expect(markup).not.toMatch(/\sstyle=/i);
        });
    });

    describe('layout', () => {
        it('renders the header controls and an empty pane grid', () => {
            const html = renderHTML();
            ['dimensionSelect', 'btn-new', 'btn-split', 'btn-popout', 'paneGrid'].forEach(id => {
                expect(html).toContain(`id="${id}"`);
            });
        });

        it('offers the pop-out button only in the sidebar', () => {
            expect(renderHTML(false)).not.toContain('id="btn-popout"');
        });

        it('uses the OpenClaw branding red for webview accents', () => {
            expect(renderHTML()).toContain('--openclaw-brand-red: #F80615');
        });
    });

    describe('generated script', () => {
        it('embeds a script that parses', () => {
            const script = renderHTML().match(/<script nonce="[^"]*">([\s\S]*)<\/script>/)?.[1];
            expect(script).toContain(CONTENT_JS);
            expect(() => new Function(script ?? '')).not.toThrow();
        });

        it('never closes its own script or style element early', () => {
            expect(CONTENT_JS).not.toMatch(/<\/script/i);
            expect(CONTENT_CSS).not.toMatch(/<\/style/i);
        });
    });
});
