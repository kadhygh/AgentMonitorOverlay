import { Notice } from "obsidian";
import { normalizeVaultFilePath } from "../core/paths";

export type FavoriteKind = "note" | "canvas";

export interface FavoriteEntry {
  path: string;
  kind: FavoriteKind;
  addedAt: string;
  remark: string;
}

export interface FavoriteListItem extends FavoriteEntry {
  displayName: string;
  exists: boolean;
}

export function favoriteKindForPath(filePath: string): FavoriteKind | null {
  const path = normalizeVaultFilePath(filePath).toLowerCase();
  if (path.endsWith(".md")) return "note";
  if (path.endsWith(".canvas")) return "canvas";
  return null;
}

export function favoriteKindForFile(file: any): FavoriteKind | null {
  if (!file || typeof file.path !== "string" || typeof file.extension !== "string") return null;
  const extension = file.extension.toLowerCase();
  if (extension === "md") return "note";
  if (extension === "canvas") return "canvas";
  return null;
}

export function normalizeFavoriteEntries(rawEntries: any): FavoriteEntry[] {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const seen = new Set<string>();
  const normalized: FavoriteEntry[] = [];

  for (const rawEntry of entries) {
    const rawPath = typeof rawEntry === "string" ? rawEntry : rawEntry && rawEntry.path;
    const path = normalizeVaultFilePath(rawPath);
    const kind = favoriteKindForPath(path);
    const key = path.toLowerCase();
    if (!path || !kind || seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      path,
      kind,
      addedAt:
        typeof rawEntry === "object" && typeof rawEntry.addedAt === "string"
          ? rawEntry.addedAt
          : "",
      remark:
        typeof rawEntry === "object" && typeof rawEntry.remark === "string"
          ? rawEntry.remark
          : "",
    });
  }

  return normalized;
}

export function listFavorites(plugin: any): FavoriteListItem[] {
  return normalizeFavoriteEntries(plugin.settings.favorites)
    .map((entry) => {
      const file = plugin.app.vault.getAbstractFileByPath(entry.path);
      return {
        ...entry,
        displayName: favoriteDisplayName(entry.path),
        exists: Boolean(file && typeof file.path === "string" && favoriteKindForFile(file) === entry.kind),
      };
    })
    .reverse();
}

export async function addFavorite(plugin: any, fileOrPath: any) {
  const candidatePath =
    typeof fileOrPath === "string" ? fileOrPath : fileOrPath && typeof fileOrPath.path === "string" ? fileOrPath.path : "";
  const path = normalizeVaultFilePath(candidatePath);
  const file = path ? plugin.app.vault.getAbstractFileByPath(path) : null;
  const kind = favoriteKindForFile(file);
  if (!file || !kind) {
    new Notice("Only Markdown notes and Canvas files in this vault can be favorited.");
    return false;
  }

  const entries = normalizeFavoriteEntries(plugin.settings.favorites);
  if (entries.some((entry) => entry.path.toLowerCase() === path.toLowerCase())) {
    plugin.setOperationStatus("Already in favorites: " + path + ".", "neutral");
    new Notice("Already in favorites.");
    return false;
  }

  plugin.settings.favorites = [
    ...entries,
    {
      path,
      kind,
      addedAt: new Date().toISOString(),
      remark: "",
    },
  ];
  await plugin.saveSettings();
  plugin.setOperationStatus("Added to favorites: " + path + ".", "success");
  plugin.debugLog("favorites.added", { path, kind });
  new Notice("Added to favorites: " + favoriteDisplayName(path));
  return true;
}

export async function removeFavorite(plugin: any, filePath: string, options: any = {}) {
  const path = normalizeVaultFilePath(filePath);
  const entries = normalizeFavoriteEntries(plugin.settings.favorites);
  const nextEntries = entries.filter((entry) => entry.path.toLowerCase() !== path.toLowerCase());
  if (nextEntries.length === entries.length) return false;

  plugin.settings.favorites = nextEntries;
  await plugin.saveSettings();
  plugin.refreshPanels();
  plugin.debugLog("favorites.removed", { path, reason: options.reason || "manual" });
  if (options.notice !== false) new Notice("Removed from favorites: " + favoriteDisplayName(path));
  return true;
}

export function getFavoriteEntry(plugin: any, filePath: string): FavoriteEntry | null {
  const path = normalizeVaultFilePath(filePath).toLowerCase();
  return normalizeFavoriteEntries(plugin.settings.favorites).find((entry) => entry.path.toLowerCase() === path) || null;
}

export async function saveFavoriteRemark(plugin: any, filePath: string, rawRemark: any) {
  const path = normalizeVaultFilePath(filePath);
  const entries = normalizeFavoriteEntries(plugin.settings.favorites);
  const index = entries.findIndex((entry) => entry.path.toLowerCase() === path.toLowerCase());
  if (index < 0) {
    new Notice("Favorite the current Note or Canvas before adding a remark.");
    return null;
  }

  const remark = String(rawRemark || "").trim();
  entries[index] = { ...entries[index], remark };
  plugin.settings.favorites = entries;
  await plugin.saveSettings();
  plugin.setOperationStatus("Saved favorite remark: " + path + ".", "success");
  plugin.debugLog("favorites.remark_saved", { path, hasRemark: remark.length > 0, length: remark.length });
  new Notice(remark ? "Favorite remark saved." : "Favorite remark cleared.");
  return entries[index];
}

export async function renameFavorite(plugin: any, file: any, oldPath: string) {
  const previousPath = normalizeVaultFilePath(oldPath);
  const nextPath = normalizeVaultFilePath(file && file.path);
  const entries = normalizeFavoriteEntries(plugin.settings.favorites);
  const previousKey = previousPath.toLowerCase();
  const previousPrefix = previousKey + "/";
  const affected = entries.filter((entry) => {
    const key = entry.path.toLowerCase();
    return key === previousKey || key.startsWith(previousPrefix);
  });
  if (affected.length === 0 || !nextPath) return false;

  const renamedEntries = entries.flatMap((entry) => {
    const key = entry.path.toLowerCase();
    if (key !== previousKey && !key.startsWith(previousPrefix)) return [entry];
    const path = normalizeVaultFilePath(nextPath + entry.path.slice(previousPath.length));
    const kind = favoriteKindForPath(path);
    return kind ? [{ ...entry, path, kind }] : [];
  });
  plugin.settings.favorites = normalizeFavoriteEntries(renamedEntries);
  await plugin.saveSettings();
  plugin.refreshPanels();
  plugin.debugLog("favorites.renamed", { oldPath: previousPath, path: nextPath, count: affected.length });
  return true;
}

export async function removeDeletedFavorites(plugin: any, deletedPath: string) {
  const path = normalizeVaultFilePath(deletedPath);
  const key = path.toLowerCase();
  const prefix = key + "/";
  const entries = normalizeFavoriteEntries(plugin.settings.favorites);
  const nextEntries = entries.filter((entry) => {
    const entryKey = entry.path.toLowerCase();
    return entryKey !== key && !entryKey.startsWith(prefix);
  });
  if (nextEntries.length === entries.length) return false;

  plugin.settings.favorites = nextEntries;
  await plugin.saveSettings();
  plugin.refreshPanels();
  plugin.debugLog("favorites.removed", {
    path,
    reason: "file-or-folder-deleted",
    count: entries.length - nextEntries.length,
  });
  return true;
}

export function favoriteDisplayName(filePath: string) {
  const name = normalizeVaultFilePath(filePath).split("/").pop() || filePath;
  return name.replace(/\.(?:md|canvas)$/i, "") || name;
}
