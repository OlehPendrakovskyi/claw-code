import type { API } from 'typescript/unstable/sync';

/** What one run of the checks found: `file:line  [rule] message` lines, and the checker query counts (#58). */
export interface CheckRulesResult {
    findings: string[];
    stats: { queries: number; cached: number };
}

/** Runs every check on the `.ts` files under `<root>/src` through `api`, which the caller owns and closes. */
export function checkRules(root: string, api: API): CheckRulesResult;
