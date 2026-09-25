/** Human-readable access summary produced for the user. */
export type AccessSummary = {
    short: string;
    markdown: string;
    generatedAt: Date;
};

/** Structured inventory of access-relevant details discovered in config/CLI output. */
export type AccessInfo = {
    mcpServers: string[];
    tools: string[];
    keySources: string[];
    networkEndpoints: string[];
    localFiles: string[];
    notes: string[];
};