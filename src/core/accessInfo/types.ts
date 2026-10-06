/** Human-readable access summary produced for the user. */
export type AccessSummary = {
    short: string;
    markdown: string;
    generatedAt: Date;
};

/** A label {@link formatNamedEntry} built, each part already redacted: shown as it is. Redacting it again would
 *  read a mask as a plain value, which runs to the end of the line, so `remote token=*** (https://host/mcp)`
 *  would lose its endpoint. Only formatNamedEntry makes one, so raw text cannot pass for it. */
export type RedactedLabel = string & { readonly redactedLabel: true };

/** Structured inventory of access-relevant details discovered in config/CLI output. MCP server and tool labels
 *  are {@link RedactedLabel}s; the other lists hold raw text, which a report redacts. */
export type AccessInfo = {
    mcpServers: RedactedLabel[];
    tools: RedactedLabel[];
    keySources: string[];
    networkEndpoints: string[];
    localFiles: string[];
    notes: string[];
};