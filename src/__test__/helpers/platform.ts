/** Pins `process.platform` for every test in the enclosing describe, so a spec that asserts
 *  one platform's branch passes on any runner. */
export function usePlatform(platform: NodeJS.Platform): void {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    beforeEach(() => {
        Object.defineProperty(process, 'platform', { ...original, value: platform });
    });
    afterEach(() => {
        Object.defineProperty(process, 'platform', original);
    });
}
