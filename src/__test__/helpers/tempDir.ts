import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The OS temp root in canonical spelling. macOS reaches it through the /var → /private/var
 *  symlink and Windows runners through an 8.3 short name, and the attachment reader rejects
 *  any path whose realpath differs. */
export const TEMP_ROOT = fs.realpathSync.native(os.tmpdir());

export function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(TEMP_ROOT, prefix));
}
