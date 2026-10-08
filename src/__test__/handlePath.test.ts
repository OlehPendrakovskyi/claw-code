import { Buffer } from 'node:buffer';
import { macHandlePath, openWindowsNoFollow, stripLongPathPrefix } from '../core/handlePath';

type NativeCall = (...args: any[]) => any;
type NodeCallback = (err: unknown, result: unknown) => void;

const isNodeCallback = (value: unknown): value is NodeCallback => typeof value === 'function';

/** Fakes for the native functions, by C name; each test sets the ones it needs. */
const native: Record<string, NativeCall> = {};
const loadedLibraries: string[] = [];

vi.mock('koffi', () => {
    const callable = (name: string) => {
        const call = (...args: unknown[]) => native[name](...args);
        // koffi's async form: the same call, answered through a Node-style callback.
        call.async = (...args: unknown[]) => {
            const callback = args.pop();
            if (!isNodeCallback(callback)) {
                throw new TypeError('koffi async calls end with a callback');
            }
            Promise.resolve().then(() => callback(null, native[name](...args)), (err: unknown) => callback(err, undefined));
        };
        return call;
    };
    return {
        default: {
            load: (library: string) => {
                loadedLibraries.push(library);
                return { func: (definition: string) => callable(/(\w+)\(/.exec(definition)![1]) };
            },
        },
    };
});

const HANDLE = 42;

/** A BY_HANDLE_FILE_INFORMATION with `attributes` and a size split into its high and low DWORDs. */
function fileInformation(attributes: number, size: number): Buffer {
    const info = Buffer.alloc(52);
    info.writeUInt32LE(attributes, 0);
    info.writeUInt32LE(Math.floor(size / 2 ** 32), 32);
    info.writeUInt32LE(size % 2 ** 32, 36);
    return info;
}

/** Native fakes for a handle that opens, with `finalPath` written as GetFinalPathNameByHandleW does. */
function openableFile(finalPath: string, info = fileInformation(0x20, 5)) {
    native.CreateFileW = vi.fn(() => HANDLE);
    native.GetFinalPathNameByHandleW = (_handle: number, buffer: Buffer) => {
        buffer.write(`${finalPath}\0`, 'utf16le');
        return finalPath.length;
    };
    native.GetFileInformationByHandle = (_handle: number, out: Buffer) => {
        info.copy(out);
        return 1;
    };
    native.GetFileType = () => 1;
    native.CloseHandle = vi.fn(() => 1);
}

describe('handlePath', () => {
    beforeEach(() => {
        for (const name of Object.keys(native)) {
            delete native[name];
        }
    });

    describe('stripLongPathPrefix', () => {
        it('takes the long-path prefix off a drive path', () => {
            expect(stripLongPathPrefix('\\\\?\\C:\\work\\note.txt')).toBe('C:\\work\\note.txt');
        });

        it('turns a long UNC path back into a UNC path', () => {
            expect(stripLongPathPrefix('\\\\?\\UNC\\host\\share\\note.txt')).toBe('\\\\host\\share\\note.txt');
        });

        it('refuses a path without the prefix GetFinalPathNameByHandleW always writes', () => {
            expect(stripLongPathPrefix('C:\\work\\note.txt')).toBeUndefined();
        });
    });

    describe('macHandlePath', () => {
        it('returns the NUL-terminated path fcntl F_GETPATH writes, from libSystem', async () => {
            const fcntl = vi.fn((_fd: number, _cmd: number, _type: string, buffer: Buffer) => {
                buffer.write('/work/caret^note.txt\0', 'utf8');
                return 0;
            });
            native.fcntl = fcntl;
            expect(await macHandlePath(7)).toBe('/work/caret^note.txt');
            expect(fcntl).toHaveBeenCalledWith(7, 50, 'void *', expect.any(Buffer));
            expect(loadedLibraries).toContain('/usr/lib/libSystem.B.dylib');
        });

        it('cannot tell when fcntl fails', async () => {
            native.fcntl = () => -1;
            expect(await macHandlePath(7)).toBeUndefined();
        });

        it('cannot tell when fcntl writes an empty path', async () => {
            native.fcntl = () => 0;
            expect(await macHandlePath(7)).toBeUndefined();
        });
    });

    describe('openWindowsNoFollow', () => {
        it('opens an existing file for reading without following a final reparse point', async () => {
            openableFile('\\\\?\\C:\\work\\note.txt');
            await openWindowsNoFollow('C:\\work\\note.txt');
            // GENERIC_READ, share read/write/delete, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT.
            expect(native.CreateFileW).toHaveBeenCalledWith('C:\\work\\note.txt', 0x80000000, 7, null, 3, 0x00200000, 0);
        });

        it('describes a regular file by its final path and its 64-bit size', async () => {
            openableFile('\\\\?\\C:\\work\\note.txt', fileInformation(0x20, 2 ** 32 + 5));
            const file = await openWindowsNoFollow('C:\\work\\note.txt');
            expect(file).toMatchObject({ finalPath: 'C:\\work\\note.txt', isRegularFile: true, size: 2 ** 32 + 5 });
        });

        it('does not count a reparse point, a directory or a non-disk file as a regular file', async () => {
            for (const attributes of [0x400, 0x10]) {
                openableFile('\\\\?\\C:\\work\\link', fileInformation(attributes, 0));
                expect((await openWindowsNoFollow('C:\\work\\link'))?.isRegularFile).toBe(false);
            }
            openableFile('\\\\?\\C:\\work\\pipe');
            native.GetFileType = () => 3;
            expect((await openWindowsNoFollow('C:\\work\\pipe'))?.isRegularFile).toBe(false);
        });

        it('returns nothing, and has nothing to close, when the open fails', async () => {
            openableFile('\\\\?\\C:\\work\\note.txt');
            native.CreateFileW = () => -1;
            expect(await openWindowsNoFollow('C:\\work\\note.txt')).toBeUndefined();
            expect(native.CloseHandle).not.toHaveBeenCalled();
        });

        it('closes the handle when its final path or its information cannot be read', async () => {
            openableFile('\\\\?\\C:\\work\\note.txt');
            native.GetFinalPathNameByHandleW = () => 0;
            expect(await openWindowsNoFollow('C:\\work\\note.txt')).toBeUndefined();
            expect(native.CloseHandle).toHaveBeenCalledWith(HANDLE);

            openableFile('\\\\?\\C:\\work\\note.txt');
            native.GetFileInformationByHandle = () => 0;
            expect(await openWindowsNoFollow('C:\\work\\note.txt')).toBeUndefined();
            expect(native.CloseHandle).toHaveBeenCalledWith(HANDLE);
        });

        it('closes the handle when the final path lacks the long-path prefix', async () => {
            openableFile('C:\\work\\note.txt');
            expect(await openWindowsNoFollow('C:\\work\\note.txt')).toBeUndefined();
            expect(native.CloseHandle).toHaveBeenCalledWith(HANDLE);
        });

        it('reads sequentially into the requested slice, and closes the handle', async () => {
            openableFile('\\\\?\\C:\\work\\note.txt');
            native.ReadFile = (_handle: number, target: Buffer, length: number, read: Buffer) => {
                const written = Buffer.from('hello').copy(target, 0, 0, length);
                read.writeUInt32LE(written, 0);
                return 1;
            };
            const file = (await openWindowsNoFollow('C:\\work\\note.txt'))!;
            const buffer = Buffer.alloc(8);
            expect(await file.read(buffer, 2, 5, 0)).toEqual({ bytesRead: 5 });
            expect(buffer.toString('utf8', 2, 7)).toBe('hello');
            await expect(file.read(buffer, 0, 1, 0)).rejects.toThrow('sequential');
            file.close();
            expect(native.CloseHandle).toHaveBeenCalledWith(HANDLE);
        });

        it('rejects a read ReadFile reports as failed', async () => {
            openableFile('\\\\?\\C:\\work\\note.txt');
            native.ReadFile = () => 0;
            const file = (await openWindowsNoFollow('C:\\work\\note.txt'))!;
            await expect(file.read(Buffer.alloc(4), 0, 4, 0)).rejects.toThrow('ReadFile failed');
        });
    });

    describe('without koffi', () => {
        it('answers nothing on either platform when koffi cannot load', async () => {
            vi.resetModules();
            vi.doMock('koffi', () => {
                throw new Error('Cannot find the native Koffi module');
            });
            try {
                const fresh = await import('../core/handlePath');
                expect(await fresh.macHandlePath(7)).toBeUndefined();
                expect(await fresh.openWindowsNoFollow('C:\\work\\note.txt')).toBeUndefined();
            } finally {
                vi.doUnmock('koffi');
            }
        });
    });
});
