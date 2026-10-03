/** Replaces `process.env` wholesale and hands back a restore handle.
 *
 *  Vitest has no `vi.replaceProperty`, and `vi.stubEnv` edits one key at a
 *  time, which cannot express the tests that hand the child a whole
 *  environment. The returned handle keeps the `try/finally` shape the call
 *  sites already use. */
export function replaceEnv(env: NodeJS.ProcessEnv): { restore: () => void } {
    const original = process.env;
    process.env = env;
    return { restore: () => { process.env = original; } };
}
