using System.Text.RegularExpressions;

namespace DEQR.Core.Security;

public static class FilenameSanitizer
{
    private static readonly HashSet<string> BlockedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".dll", ".ps1", ".bat", ".cmd", ".js",
        ".vbs", ".msi", ".scr", ".com", ".pif", ".hta",
        ".wsh", ".wsf"
    };

    public static string SanitizeFilename(string filename)
    {
        if (string.IsNullOrEmpty(filename))
        {
            return "unnamed";
        }

        // Remove null bytes
        string sanitized = filename.Replace("\0", "");

        // Extract basename
        int lastSlash = Math.Max(sanitized.LastIndexOf('/'), sanitized.LastIndexOf('\\'));
        if (lastSlash >= 0)
        {
            sanitized = sanitized.Substring(lastSlash + 1);
        }

        // Remove directory traversal patterns
        sanitized = sanitized.Replace("..", "");

        // Remove control characters (0x00-0x1F, 0x7F)
        sanitized = Regex.Replace(sanitized, @"[\x00-\x1f\x7f]", "");

        // Remove Windows reserved characters
        sanitized = Regex.Replace(sanitized, @"[<>:""|?*]", "_");

        // Trim whitespace and dots from start/end
        sanitized = sanitized.Trim(' ', '\t', '\r', '\n', '.');

        if (string.IsNullOrEmpty(sanitized))
        {
            return "unnamed";
        }

        // Cap length to 255 characters
        if (sanitized.Length > 255)
        {
            string ext = GetExtension(sanitized);
            string baseName = sanitized.Substring(0, 255 - ext.Length);
            sanitized = baseName + ext;
        }

        return sanitized;
    }

    public static string GetExtension(string filename)
    {
        int dotIndex = filename.LastIndexOf('.');
        if (dotIndex < 0) return string.Empty;
        return filename.Substring(dotIndex);
    }

    public static bool IsBlockedExtension(string filename)
    {
        string ext = GetExtension(filename);
        return BlockedExtensions.Contains(ext);
    }
}
