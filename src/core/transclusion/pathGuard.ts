import { isUnsafeUriScheme } from "../../util/links";

export type SafeVaultPathResult =
  | { ok: true; vaultPath: string }
  | { ok: false; reason: string };

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const EXPLICIT_URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:(?:[\\/]|$)/;
const HOME_PATH_RE = /^~(?:[\\/]|$)|^~[^\\/]+[\\/]/;
const BLOCKED_HIDDEN_SEGMENTS = new Set([".obsidian", ".git"]);

function checkCandidateString(candidate: string, originalRaw: string): string | null {
  if (!candidate) {
    return "Empty transclusion file path";
  }
  if (CONTROL_CHARS_RE.test(candidate)) {
    return `Path contains control characters: ${originalRaw}`;
  }
  if (isUnsafeUriScheme(candidate)) {
    return `Blocked unsafe URI scheme: ${originalRaw}`;
  }
  if (/^file:\/\//i.test(candidate)) {
    return `External file:// URI is outside vault boundary: ${originalRaw}`;
  }
  if (/^(https?|ftp|mailto|obsidian|shell|elisp):/i.test(candidate)) {
    return `Unsupported external URI scheme: ${originalRaw}`;
  }
  return null;
}

function stripSingleFilePrefix(value: string): string {
  return /^file:/i.test(value) ? value.slice(5).trim() : value;
}

function checkStrippedPath(stripped: string, originalRaw: string): string | null {
  if (!stripped) {
    return `Empty transclusion file path: ${originalRaw}`;
  }
  if (CONTROL_CHARS_RE.test(stripped)) {
    return `Path contains control characters: ${originalRaw}`;
  }
  if (isUnsafeUriScheme(stripped) || /^file:\/\//i.test(stripped)) {
    return `Blocked unsafe URI scheme: ${originalRaw}`;
  }
  if (WINDOWS_DRIVE_RE.test(stripped)) {
    return `Windows drive path is outside vault boundary: ${originalRaw}`;
  }
  if (EXPLICIT_URI_SCHEME_RE.test(stripped)) {
    return `Unsupported URI scheme in file path: ${originalRaw}`;
  }
  if (stripped.startsWith("\\\\") || stripped.startsWith("//")) {
    return `UNC/network path is outside vault boundary: ${originalRaw}`;
  }
  if (stripped.startsWith("/") || stripped.startsWith("\\")) {
    return `Absolute path is outside vault boundary: ${originalRaw}`;
  }
  if (HOME_PATH_RE.test(stripped)) {
    return `Home-relative path is outside vault boundary: ${originalRaw}`;
  }
  if (stripped.endsWith("/") || stripped.endsWith("\\")) {
    return `Directory target is not a valid file path: ${originalRaw}`;
  }
  return null;
}

function resolveSegments(
  normalizedPath: string,
  baseDirSegments: string[],
  originalRaw: string
): SafeVaultPathResult {
  const stack = [...baseDirSegments];
  const segments = normalizedPath.split("/");

  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length === 0) {
        return {
          ok: false,
          reason: `Path escapes vault boundary: ${originalRaw}`,
        };
      }
      stack.pop();
      continue;
    }
    if (BLOCKED_HIDDEN_SEGMENTS.has(segment.toLowerCase())) {
      return {
        ok: false,
        reason: `Access to protected directory "${segment}" is blocked: ${originalRaw}`,
      };
    }
    stack.push(segment);
  }

  if (stack.length === 0) {
    return {
      ok: false,
      reason: `Path resolves to empty vault location: ${originalRaw}`,
    };
  }

  return {
    ok: true,
    vaultPath: stack.join("/"),
  };
}

function getBaseDirectorySegments(sourcePath: string): string[] {
  const normalized = sourcePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^\.\//, "");
  if (!normalized) return [];
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return [];
  return normalized
    .slice(0, lastSlash)
    .split("/")
    .filter((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Resolve a transclusion `file:` link target into a normalized vault-relative path,
 * blocking path traversal, absolute OS paths, UNC shares, home paths, unsafe URI
 * schemes, percent-encoded escapes, and protected metadata directories.
 */
export function resolveSafeVaultPath(rawPath: string, sourcePath: string): SafeVaultPathResult {
  const trimmed = rawPath.trim();
  const rawErr = checkCandidateString(trimmed, rawPath);
  if (rawErr) {
    return { ok: false, reason: rawErr };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed).trim();
  } catch {
    return {
      ok: false,
      reason: `Malformed percent-encoding in path: ${rawPath}`,
    };
  }

  const decodedErr = checkCandidateString(decoded, rawPath);
  if (decodedErr) {
    return { ok: false, reason: decodedErr };
  }

  const rawStripped = stripSingleFilePrefix(trimmed);
  const rawStrippedErr = checkStrippedPath(rawStripped, rawPath);
  if (rawStrippedErr) {
    return { ok: false, reason: rawStrippedErr };
  }

  const decodedStripped = stripSingleFilePrefix(decoded);
  const decodedStrippedErr = checkStrippedPath(decodedStripped, rawPath);
  if (decodedStrippedErr) {
    return { ok: false, reason: decodedStrippedErr };
  }

  const baseDirSegments = getBaseDirectorySegments(sourcePath);

  const rawNormalized = rawStripped.replace(/\\/g, "/");
  const rawResolved = resolveSegments(rawNormalized, baseDirSegments, rawPath);
  if (!rawResolved.ok) {
    return rawResolved;
  }

  const decodedNormalized = decodedStripped.replace(/\\/g, "/");
  const decodedResolved = resolveSegments(decodedNormalized, baseDirSegments, rawPath);
  if (!decodedResolved.ok) {
    return decodedResolved;
  }

  return decodedResolved;
}
