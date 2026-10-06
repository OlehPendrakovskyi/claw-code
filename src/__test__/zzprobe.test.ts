import { it } from 'vitest';
import { redactText, redactEndpointText } from '../core/accessInfo/redact';
import { appendFileSync } from 'fs';
const out = '/tmp/claude-1000/-home-opendrakovsky-personal-claw-code-rules/3ca8c80c-546d-4eb9-a3c8-9ffc74f30067/scratchpad/out.txt';
it('probe', () => {
    for (const t of ['remote token="PRIVATE" (https://api.example/mcp)', 'remote token="PRIVATE"', 'remote token=PRIVATE', 'remote token=*** (https://api.example/mcp)', 'remote token="***" (https://api.example/mcp)', "x token='P Q' (u)", 'x Bearer "P Q" (u)', 'x password=PRIVATE (https://a.example)'])
        appendFileSync(out, JSON.stringify([t, redactText(t), redactEndpointText(t)]) + '\n');
});
