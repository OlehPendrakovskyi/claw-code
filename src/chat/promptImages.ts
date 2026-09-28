import { randomUUID } from 'crypto';

/** An image attachment waiting to travel to acpx as an ACP image block. */
export type PromptImage = {
    name: string;
    mimeType: string;
    /** Base64 of the verified file bytes. */
    data: string;
};

/** Where a staged image sits in the prompt text; the id is random, so prompt
 *  content cannot name an image it was not given. */
export const PROMPT_IMAGE_MARKER = /<image ref="([0-9a-f-]{36})" \/>/g;

const staged = new Map<string, PromptImage>();

/** Stages `image` until {@link releasePromptImage}, returning its marker. */
export function stagePromptImage(image: PromptImage): { id: string; marker: string } {
    const id = randomUUID();
    staged.set(id, image);
    return { id, marker: `<image ref="${id}" />` };
}

export function stagedPromptImage(id: string): PromptImage | undefined {
    return staged.get(id);
}

export function releasePromptImage(id: string): void {
    staged.delete(id);
}
