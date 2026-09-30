/**
 * Media type utilities for Claw Code.
 */

/**
 * Recognized image file extensions, lowercase with the leading dot.
 *
 * Shared by attachment validation and webview rendering; keep in sync
 * with the transport's image MIME mapping.
 */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tif', '.tiff'];

/**
 * Check if a MIME type represents an image.
 */
export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}
