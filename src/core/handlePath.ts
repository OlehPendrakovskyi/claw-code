/**
 * Claw Code — what the operating system says an opened file is, where Node cannot ask.
 *
 * The attachment reader proves a file is inside the workspace by the opened handle's own
 * path (development rule R6). Linux answers through /proc/self/fd, which Node reads. macOS
 * (`F_GETPATH`) and Windows (`GetFinalPathNameByHandleW`, and an open that does not follow
 * a reparse point) answer only through system calls Node does not expose, so they are made
 * here through koffi. Where koffi or a call is unavailable the answer is `undefined`, and
 * the reader refuses the file.
 *
 * The packaged extension loads koffi from `out/native/node_modules` (see `esbuild.mjs`).
 */

import { Buffer } from 'node:buffer';
import { promisify } from 'node:util';

type Koffi = typeof import('koffi')['default'];
type KoffiFunction = ReturnType<ReturnType<Koffi['load']>['func']>;

let koffiLoad: Promise<Koffi | undefined> | undefined;

/** koffi, loaded once on first use; undefined where it has no binary for this platform. Its API is read
 *  from `default`, the only export an `import()` of the bundled CommonJS copy has. */
function loadKoffi(): Promise<Koffi | undefined> {
    koffiLoad ??= import('koffi').then((koffi) => koffi.default, () => undefined);
    return koffiLoad;
}

/** `fcntl` command that copies a descriptor's full path into a MAXPATHLEN buffer (<sys/fcntl.h>). */
const F_GETPATH = 50;
const MAXPATHLEN = 1024;

let macFcntl: Promise<KoffiFunction | undefined> | undefined;

function loadMacFcntl(): Promise<KoffiFunction | undefined> {
    macFcntl ??= loadKoffi().then((koffi) => {
        try {
            return koffi?.load('/usr/lib/libSystem.B.dylib').func('int fcntl(int fd, int cmd, ...)');
        } catch {
            return undefined;
        }
    });
    return macFcntl;
}

/** The full path macOS reports for this process's open descriptor `fd`, or undefined when it cannot tell.
 *  The answer follows the opened file, so an ancestor directory swapped before the open shows up. */
export async function macHandlePath(fd: number): Promise<string | undefined> {
    const fcntl = await loadMacFcntl();
    if (!fcntl) {
        return undefined;
    }
    const buffer = Buffer.alloc(MAXPATHLEN);
    // fcntl is variadic, and Apple's arm64 ABI passes variadic arguments on the stack, so the buffer goes as one.
    if (fcntl(fd, F_GETPATH, 'void *', buffer) === -1) {
        return undefined;
    }
    const end = buffer.indexOf(0);
    return end <= 0 ? undefined : buffer.toString('utf8', 0, end);
}

// Win32 constants, from <winnt.h>, <fileapi.h> and <winbase.h>.
const GENERIC_READ = 0x80000000;
// As Node's own open shares, so an editor holding the file open does not make it unreadable.
const FILE_SHARE_READ_WRITE_DELETE = 0x1 | 0x2 | 0x4;
const OPEN_EXISTING = 3;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_TYPE_DISK = 1;
const INVALID_HANDLE_VALUE = -1;
const VOLUME_NAME_DOS = 0;
/** Size of BY_HANDLE_FILE_INFORMATION: thirteen DWORDs. Attributes at 0, size high and low at 32 and 36. */
const FILE_INFORMATION_BYTES = 52;
/** The longest path GetFinalPathNameByHandleW can return, in UTF-16 units including the NUL. */
const MAX_FINAL_PATH_CHARS = 32768;

interface Win32 {
    CreateFileW: KoffiFunction;
    GetFileType: KoffiFunction;
    GetFileInformationByHandle: KoffiFunction;
    GetFinalPathNameByHandleW: KoffiFunction;
    ReadFile: KoffiFunction;
    CloseHandle: KoffiFunction;
}

let win32: Promise<Win32 | undefined> | undefined;

// Handles are declared `intptr` so they arrive as numbers and INVALID_HANDLE_VALUE is -1. Only x64 and arm64
// binaries ship, where Windows has one calling convention.
function loadWin32(): Promise<Win32 | undefined> {
    win32 ??= loadKoffi().then((koffi) => {
        try {
            const kernel32 = koffi?.load('kernel32.dll');
            return kernel32 && {
                CreateFileW: kernel32.func('intptr CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, intptr template)'),
                GetFileType: kernel32.func('uint32 GetFileType(intptr handle)'),
                GetFileInformationByHandle: kernel32.func('int GetFileInformationByHandle(intptr handle, _Out_ void *info)'),
                GetFinalPathNameByHandleW: kernel32.func('uint32 GetFinalPathNameByHandleW(intptr handle, _Out_ void *path, uint32 chars, uint32 flags)'),
                ReadFile: kernel32.func('int ReadFile(intptr handle, _Out_ void *buffer, uint32 length, _Out_ void *read, void *overlapped)'),
                CloseHandle: kernel32.func('int CloseHandle(intptr handle)'),
            };
        } catch {
            return undefined;
        }
    });
    return win32;
}

/** A file Windows opened without following a final reparse point, described by its handle. */
export interface WindowsFileHandle {
    /** The handle's own path, as `fs.promises.realpath` spells it. */
    readonly finalPath: string;
    /** A disk file that is neither a directory nor a reparse point. */
    readonly isRegularFile: boolean;
    readonly size: number;
    /** Reads sequentially from the start; `position` must be the number of bytes read so far. */
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
    close(): void;
}

/** Open `filePath` for reading without following a final symlink or junction, or undefined when it
 *  cannot be opened or described. The caller closes what it gets. */
export async function openWindowsNoFollow(filePath: string): Promise<WindowsFileHandle | undefined> {
    const api = await loadWin32();
    if (!api) {
        return undefined;
    }
    const handle: number = api.CreateFileW(
        filePath, GENERIC_READ, FILE_SHARE_READ_WRITE_DELETE, null, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, 0,
    );
    if (handle === INVALID_HANDLE_VALUE) {
        return undefined;
    }
    const info = Buffer.alloc(FILE_INFORMATION_BYTES);
    const finalPath = finalPathOf(api, handle);
    if (finalPath === undefined || api.GetFileInformationByHandle(handle, info) === 0) {
        api.CloseHandle(handle);
        return undefined;
    }
    const attributes = info.readUInt32LE(0);
    const readFile = promisify(api.ReadFile.async);
    let readSoFar = 0;
    return {
        finalPath,
        isRegularFile: api.GetFileType(handle) === FILE_TYPE_DISK
            && (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) === 0,
        size: info.readUInt32LE(32) * 2 ** 32 + info.readUInt32LE(36),
        async read(buffer, offset, length, position) {
            if (position !== readSoFar) {
                throw new Error('Windows handle reads are sequential');
            }
            const target = buffer.subarray(offset, offset + length);
            const bytesRead = Buffer.alloc(4);
            if ((await readFile(handle, target, target.length, bytesRead, null)) === 0) {
                throw new Error('ReadFile failed');
            }
            readSoFar += bytesRead.readUInt32LE(0);
            return { bytesRead: bytesRead.readUInt32LE(0) };
        },
        close() {
            api.CloseHandle(handle);
        },
    };
}

/** The handle's path with the `\\?\` prefix taken off as libuv's realpath does: `\\?\C:\x` → `C:\x`,
 *  `\\?\UNC\host\share` → `\\host\share`. Undefined when Windows cannot tell. */
function finalPathOf(api: Win32, handle: number): string | undefined {
    const buffer = Buffer.alloc(MAX_FINAL_PATH_CHARS * 2);
    const length: number = api.GetFinalPathNameByHandleW(handle, buffer, MAX_FINAL_PATH_CHARS, VOLUME_NAME_DOS);
    if (length === 0 || length >= MAX_FINAL_PATH_CHARS) {
        return undefined;
    }
    return stripLongPathPrefix(buffer.toString('utf16le', 0, length * 2));
}

export function stripLongPathPrefix(finalPath: string): string | undefined {
    if (finalPath.startsWith('\\\\?\\UNC\\')) {
        return `\\${finalPath.slice('\\\\?\\UNC'.length)}`;
    }
    if (finalPath.startsWith('\\\\?\\')) {
        return finalPath.slice('\\\\?\\'.length);
    }
    return undefined;
}
