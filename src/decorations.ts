import { sharedClient } from "./client";
import type { PluginAPI } from "./types";

const modifiedPaths = new Set<string>();
let refreshGeneration = 0;

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function containsModifiedPath(path: string): boolean {
  const directory = normalizedPath(path);
  if (!directory || directory === ".") return modifiedPaths.size > 0;
  for (const modified of modifiedPaths) {
    if (modified === directory || modified.startsWith(`${directory}/`)) return true;
  }
  return false;
}

export async function refreshDriveDecorations(api: PluginAPI): Promise<void> {
  const generation = ++refreshGeneration;
  let paths: string[] = [];
  try {
    paths = await sharedClient(api).localChangePaths();
  } catch {
    // A disconnected or switched Workspace has no meaningful sync decoration.
  }
  if (generation !== refreshGeneration) return;
  modifiedPaths.clear();
  paths.map(normalizedPath).forEach((path) => modifiedPaths.add(path));
  api.fileTree?.refreshDecorations();
}

export function installDriveDecorations(api: PluginAPI): () => void {
  if (!api.fileTree) return () => undefined;
  const removeProvider = api.fileTree.registerDecorationProvider((target) => {
    if (target.scope !== "workspace") return null;
    const modified = target.isDirectory
      ? containsModifiedPath(target.path)
      : modifiedPaths.has(normalizedPath(target.path));
    return modified
      ? { color: "#eab308", title: target.isDirectory ? "Contains changes not pushed to Google Drive" : "Not pushed to Google Drive" }
      : null;
  });
  let timer: number | undefined;
  const refreshSoon = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => void refreshDriveDecorations(api), 250);
  };
  const removeListener = api.onFilesChanged?.(refreshSoon) ?? (() => undefined);
  void refreshDriveDecorations(api);
  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    removeListener();
    removeProvider();
    modifiedPaths.clear();
  };
}
