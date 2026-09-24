import { request, type TransportResponse } from "./transport";
import { buildConflictBackupName } from "gemihub-sync-core/conflict";
import { isGoogleWorkspaceMimeType, isSyncExcludedPath } from "gemihub-sync-core/paths";
import { reconcileSyncMetaWithListing, syncMetaFromDriveFiles } from "gemihub-sync-core/protocol";
import type { PluginAPI, SyncMeta } from "./types";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
// System names/folders, exclusion patterns and conflict names are shared with
// GemiHub web and Obsidian through gemihub-sync-core.
export { SYNC_EXCLUDED_FILE_NAMES as SYSTEM_NAMES, SYNC_EXCLUDED_PREFIXES as SYSTEM_PREFIXES, isUserExcludedPath } from "gemihub-sync-core/paths";

export interface DriveFile { id: string; name: string; mimeType: string; modifiedTime?: string; createdTime?: string; parents?: string[]; md5Checksum?: string; size?: string }

export function isGoogleWorkspaceFile(file: Pick<DriveFile, "mimeType">): boolean {
  return isGoogleWorkspaceMimeType(file.mimeType);
}

export function syncableDriveFile(file: Pick<DriveFile, "name" | "mimeType">): boolean {
  return syncablePath(file.name) && !isGoogleWorkspaceFile(file);
}

function escapeQuery(value: string): string { return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

/** Desktop keeps workspace state in `.llm-hub/`; everything else is the shared rule. */
export function syncablePath(path: string): boolean {
  return !isSyncExcludedPath(path, { extraSegments: [".llm-hub"] });
}

async function driveRequest(api: PluginAPI, url: string, accessToken: string, options: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer; contentType?: string } = {}, retries = 2): Promise<TransportResponse> {
  const response = await request(api, url, {
    method: options.method ?? "GET",
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.contentType ? { "Content-Type": options.contentType } : {}), ...options.headers },
    body: options.body,
  });
  if ((response.status === 429 || response.status === 503) && retries > 0) {
    const seconds = Math.min(10, Number.parseInt(response.headers["retry-after"] ?? "2", 10) || 2);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return driveRequest(api, url, accessToken, options, retries - 1);
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`Google Drive API ${response.status}: ${response.text.slice(0, 240)}`);
  return response;
}

export async function listRootFiles(api: PluginAPI, accessToken: string, rootFolderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken = "";
  do {
    const url = new URL(`${API}/files`);
    url.searchParams.set("q", `'${escapeQuery(rootFolderId)}' in parents and trashed=false`);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,md5Checksum,size,parents)");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = (await driveRequest(api, url.toString(), accessToken)).json as { files?: DriveFile[]; nextPageToken?: string };
    files.push(...(body.files ?? []));
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return files.filter(syncableDriveFile);
}

export async function findByName(api: PluginAPI, accessToken: string, rootFolderId: string, name: string): Promise<DriveFile | null> {
  return (await findAllByName(api, accessToken, rootFolderId, name))[0] ?? null;
}

async function findAllByName(api: PluginAPI, accessToken: string, rootFolderId: string, name: string): Promise<DriveFile[]> {
  const query = encodeURIComponent(`name='${escapeQuery(name)}' and '${escapeQuery(rootFolderId)}' in parents and trashed=false`);
  const body = (await driveRequest(api, `${API}/files?q=${query}&orderBy=modifiedTime%20desc&fields=files(id,name,mimeType,modifiedTime,createdTime,md5Checksum,size,parents)&pageSize=1000`, accessToken)).json as { files?: DriveFile[] };
  return body.files ?? [];
}

export async function readRemote(api: PluginAPI, accessToken: string, id: string): Promise<{ text: string; buffer: ArrayBuffer }> {
  const response = await driveRequest(api, `${API}/files/${encodeURIComponent(id)}?alt=media`, accessToken);
  return { text: response.text, buffer: response.arrayBuffer };
}

function multipart(name: string, content: string | ArrayBuffer, mimeType: string, parent: string): { body: string | ArrayBuffer; contentType: string } {
  const boundary = `gemihub-gdrive-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, mimeType, parents: [parent] });
  if (typeof content === "string") return {
    contentType: `multipart/related; boundary=${boundary}`,
    body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`,
  };
  const prefix = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const suffix = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(prefix.length + content.byteLength + suffix.length);
  body.set(prefix); body.set(new Uint8Array(content), prefix.length); body.set(suffix, prefix.length + content.byteLength);
  return { contentType: `multipart/related; boundary=${boundary}`, body: body.buffer };
}

export async function createRemote(api: PluginAPI, accessToken: string, rootFolderId: string, name: string, content: string | ArrayBuffer, mimeType: string): Promise<DriveFile> {
  const payload = multipart(name, content, mimeType, rootFolderId);
  const response = await driveRequest(api, `${UPLOAD}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,createdTime,md5Checksum,size,parents`, accessToken, { method: "POST", contentType: payload.contentType, body: payload.body });
  return response.json as DriveFile;
}

export async function updateRemote(api: PluginAPI, accessToken: string, id: string, content: string | ArrayBuffer, mimeType: string): Promise<DriveFile> {
  const response = await driveRequest(api, `${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id,name,mimeType,modifiedTime,createdTime,md5Checksum,size,parents`, accessToken, { method: "PATCH", contentType: mimeType, body: content });
  return response.json as DriveFile;
}

export async function renameRemote(api: PluginAPI, accessToken: string, id: string, name: string): Promise<void> {
  await driveRequest(api, `${API}/files/${encodeURIComponent(id)}?fields=id`, accessToken, { method: "PATCH", contentType: "application/json", body: JSON.stringify({ name }) });
}

export async function ensureFolder(api: PluginAPI, accessToken: string, rootFolderId: string, name: string): Promise<string> {
  const query = encodeURIComponent(`name='${escapeQuery(name)}' and '${escapeQuery(rootFolderId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const listed = (await driveRequest(api, `${API}/files?q=${query}&fields=files(id)&pageSize=1`, accessToken)).json as { files?: Array<{ id: string }> };
  if (listed.files?.[0]) return listed.files[0].id;
  const created = (await driveRequest(api, `${API}/files?fields=id`, accessToken, { method: "POST", contentType: "application/json", body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [rootFolderId] }) })).json as { id: string };
  return created.id;
}

/** Same naming scheme as GemiHub's saveConflictBackup: path separators become
 * underscores and a timestamp is inserted before the extension. */
export function conflictBackupName(path: string, now = new Date()): string {
  return buildConflictBackupName(path, now);
}

export async function moveRemote(api: PluginAPI, accessToken: string, id: string, from: string, to: string): Promise<void> {
  await driveRequest(api, `${API}/files/${encodeURIComponent(id)}?addParents=${encodeURIComponent(to)}&removeParents=${encodeURIComponent(from)}&fields=id`, accessToken, { method: "PATCH" });
}

export function metaFromFiles(files: DriveFile[]): SyncMeta {
  return syncMetaFromDriveFiles(files, syncableDriveFile);
}

/**
 * Treat the Drive folder listing as authoritative while retaining metadata
 * fields that are not returned by the listing request. GemiHub may briefly
 * have duplicate or stale _sync-meta.json files after concurrent operations;
 * relying on one of those files alone hides newly-created and deleted files.
 */
export function reconcileSyncMeta(meta: SyncMeta | null, files: DriveFile[]): SyncMeta {
  return reconcileSyncMetaWithListing(meta, files, syncableDriveFile);
}

function syncMetaSignature(value: SyncMeta): string {
  return JSON.stringify(Object.entries(value.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, file]) => [id, file.name, file.mimeType, file.md5Checksum, file.modifiedTime, file.size]));
}

export async function readSyncMeta(api: PluginAPI, accessToken: string, rootFolderId: string): Promise<SyncMeta> {
  const file = await findByName(api, accessToken, rootFolderId, "_sync-meta.json");
  let parsed: SyncMeta | null = null;
  if (file) {
    try {
      parsed = JSON.parse((await readRemote(api, accessToken, file.id)).text) as SyncMeta;
      parsed.files = Object.fromEntries(Object.entries(parsed.files ?? {}).filter(([, item]) => syncableDriveFile(item)));
    } catch { /* reconcile the live Drive listing without malformed metadata */ }
  }
  return reconcileSyncMeta(parsed, await listRootFiles(api, accessToken, rootFolderId));
}

export async function writeSyncMeta(api: PluginAPI, accessToken: string, rootFolderId: string, meta: SyncMeta): Promise<SyncMeta> {
  let expected = meta;
  for (let attempt = 0; attempt < 2; attempt++) {
    const liveFiles = await listRootFiles(api, accessToken, rootFolderId);
    expected = reconcileSyncMeta(expected, liveFiles);
    expected.lastUpdatedAt = new Date().toISOString();
    const matches = await findAllByName(api, accessToken, rootFolderId, "_sync-meta.json");
    const nativeFiles: SyncMeta["files"] = {};
    const previousEntries: SyncMeta["files"] = {};
    for (const match of matches) {
      try {
        const current = JSON.parse((await readRemote(api, accessToken, match.id)).text) as SyncMeta;
        for (const [id, item] of Object.entries(current.files ?? {})) {
          if (isGoogleWorkspaceFile(item)) nativeFiles[id] = item;
          else previousEntries[id] = { ...previousEntries[id], ...item };
        }
      } catch { /* overwrite malformed or unreadable duplicate metadata */ }
    }
    // GemiHub keeps sharing state (shared/webViewLink) only inside _sync-meta.json,
    // so entries rebuilt from the Drive listing must carry the current fields over.
    const files = Object.fromEntries(Object.entries(expected.files).map(([id, file]) => [id, { ...previousEntries[id], ...file }]));
    const content = JSON.stringify({ ...expected, files: { ...nativeFiles, ...files } }, null, 2);
    if (matches.length) await Promise.all(matches.map((match) => updateRemote(api, accessToken, match.id, content, "application/json")));
    else await createRemote(api, accessToken, rootFolderId, "_sync-meta.json", content, "application/json");

    const after = metaFromFiles(await listRootFiles(api, accessToken, rootFolderId));
    if (syncMetaSignature(after) === syncMetaSignature(expected)) return expected;
    expected = after;
  }
  throw new Error("Google Drive changed while writing sync metadata. Check changes and retry.");
}
