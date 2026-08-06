/**
 * Filename Sanitizer
 *
 * Strips path separators, directory traversal sequences, null bytes,
 * and control characters from filenames to prevent path traversal attacks.
 */

/**
 * Sanitize a filename for safe storage.
 * Strips path components, traversal patterns, null bytes, and control chars.
 * Returns only the basename.
 */
export function sanitizeFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    return 'unnamed';
  }

  // Remove null bytes
  let sanitized = filename.replace(/\0/g, '');

  // Extract basename — strip everything before the last path separator
  const lastSlash = Math.max(
    sanitized.lastIndexOf('/'),
    sanitized.lastIndexOf('\\')
  );
  if (lastSlash >= 0) {
    sanitized = sanitized.substring(lastSlash + 1);
  }

  // Remove directory traversal patterns
  sanitized = sanitized.replace(/\.\./g, '');

  // Remove control characters (0x00-0x1F, 0x7F)
  sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, '');

  // Remove Windows reserved characters
  sanitized = sanitized.replace(/[<>:"|?*]/g, '_');

  // Trim whitespace and dots from start/end
  sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, '');

  // If nothing remains, use a default
  if (!sanitized) {
    return 'unnamed';
  }

  // Cap length to 255 characters (common filesystem limit)
  if (sanitized.length > 255) {
    const ext = getExtension(sanitized);
    const base = sanitized.substring(0, 255 - ext.length);
    sanitized = base + ext;
  }

  return sanitized;
}

/**
 * Extract file extension including the dot.
 */
function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 0) return '';
  return filename.substring(dotIndex);
}

/**
 * Check if a file extension is in the blocked list.
 */
export const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.ps1', '.bat', '.cmd', '.js',
  '.vbs', '.msi', '.scr', '.com', '.pif', '.hta',
  '.wsh', '.wsf',
]);

export function isBlockedExtension(filename: string): boolean {
  const ext = getExtension(filename).toLowerCase();
  return BLOCKED_EXTENSIONS.has(ext);
}
