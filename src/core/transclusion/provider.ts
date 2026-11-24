import { App, TFile } from "obsidian";
import type { OrgIdIndex } from "../index/orgIdIndex";
import { resolveSafeVaultPath } from "./pathGuard";
import type { TransclusionContentProvider, TransclusionIdLookup } from "./types";

/**
 * Create a strictly read-only `TransclusionContentProvider` backed by Obsidian's
 * vault file cache (`app.vault.cachedRead`) and the shared `OrgIdIndex`.
 */
export function createVaultTransclusionProvider(
  app: App,
  index: OrgIdIndex
): TransclusionContentProvider {
  return {
    resolveId(id: string): TransclusionIdLookup {
      return index.resolveId(id);
    },
    async readFile(vaultPath: string): Promise<string | null> {
      const safe = resolveSafeVaultPath(vaultPath, "");
      if (!safe.ok) return null;
      const abstract =
        app.vault.getAbstractFileByPath(safe.vaultPath) ??
        app.vault.getFiles().find((file) => file.path === safe.vaultPath);
      if (!(abstract instanceof TFile)) return null;
      return app.vault.cachedRead(abstract);
    },
  };
}

/**
 * Create an in-memory read-only `TransclusionContentProvider` for headless tests
 * or isolated previews, backed by an `OrgIdIndex` and a map of vault-relative paths.
 */
export function createMemoryTransclusionProvider(
  files: ReadonlyMap<string, string>,
  index: OrgIdIndex
): TransclusionContentProvider {
  return {
    resolveId(id: string): TransclusionIdLookup {
      return index.resolveId(id);
    },
    readFile(vaultPath: string): string | null {
      const safe = resolveSafeVaultPath(vaultPath, "");
      if (!safe.ok) return null;
      return files.get(safe.vaultPath) ?? null;
    },
  };
}
