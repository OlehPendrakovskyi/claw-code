import { escapeXmlAttr } from '../webview/slashCommands';

describe('escapeXmlAttr', () => {
    it('escapes XML-attribute-significant characters', () => {
        expect(escapeXmlAttr('&')).toBe('&#38;');
        expect(escapeXmlAttr('<')).toBe('&#60;');
        expect(escapeXmlAttr('>')).toBe('&#62;');
        expect(escapeXmlAttr('"')).toBe('&#34;');
        expect(escapeXmlAttr("'")).toBe('&#39;');
    });

    it('encodes control characters so a value cannot start a new prompt line', () => {
        expect(escapeXmlAttr('a\nb\r\tc\u0000\u007f')).toBe('a&#10;b&#13;&#9;c&#0;&#127;');
    });

    it('escapes a mixed path without breaking attribute syntax', () => {
        expect(escapeXmlAttr('/tmp/a"b&c<d>.txt')).toBe('/tmp/a&#34;b&#38;c&#60;d&#62;.txt');
    });

    it('leaves ordinary paths untouched', () => {
        expect(escapeXmlAttr('/home/user/report-final.pdf')).toBe('/home/user/report-final.pdf');
    });
});