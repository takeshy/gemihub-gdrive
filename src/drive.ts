import { request, type TransportResponse } from "./transport";
import type { FileSyncMeta, PluginAPI, SyncMeta } from "./types";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const SYSTEM_NAMES = new Set(["_sync-meta.json", "_encrypted-auth.json", "settings.json"]);
export const SYSTEM_PREFIXES = ["history/", "trash/", "sync_conflicts/", "__TEMP__/", "plugins/"];

export interface DriveFile { id: string; name: string; mimeType: string; modifiedTime?: string; createdTime?: string; parents?: string[]; md5Checksum?: string; size?: string }

export function isGoogleWorkspaceFile(file: Pick<DriveFile, "mimeType">): boolean {
  return file.mimeType.startsWith("application/vnd.google-apps.");
}

export function syncableDriveFile(file: Pick<DriveFile, "name" | "mimeType">): boolean {
  return syncablePath(file.name) && !isGoogleWorkspaceFile(file);
}

function escapeQuery(value: string): string { return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
export function syncablePath(path: string): boolean {
  const clean = path.replace(/^\/+/, "");
  return !!clean && !SYSTEM_NAMES.has(clean) && !SYSTEM_PREFIXES.some((prefix) => clean.startsWith(prefix)) && !clean.split("/").some((part) => part === ".git" || part === ".llm-hub" || part === "node_modules");
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
  const query = encodeURIComponent(`name='${escapeQuery(name)}' and '${escapeQuery(rootFolderId)}' in parents and trashed=false`);
  const body = (await driveRequest(api, `${API}/files?q=${query}&fields=files(id,name,mimeType,modifiedTime,createdTime,md5Checksum,size,parents)&pageSize=1`, accessToken)).json as { files?: DriveFile[] };
  return body.files?.[0] ?? null;
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

export async function moveRemote(api: PluginAPI, accessToken: string, id: string, from: string, to: string): Promise<void> {
  await driveRequest(api, `${API}/files/${encodeURIComponent(id)}?addParents=${encodeURIComponent(to)}&removeParents=${encodeURIComponent(from)}&fields=id`, accessToken, { method: "PATCH" });
}

export function metaFromFiles(files: DriveFile[]): SyncMeta {
  return {
    lastUpdatedAt: new Date().toISOString(),
    files: Object.fromEntries(files.filter(syncableDriveFile).map((file) => [file.id, {
      name: file.name, mimeType: file.mimeType, md5Checksum: file.md5Checksum ?? "", modifiedTime: file.modifiedTime ?? "", createdTime: file.createdTime, size: file.size,
    } satisfies FileSyncMeta])),
  };
}

export async function readSyncMeta(api: PluginAPI, accessToken: string, rootFolderId: string): Promise<SyncMeta> {
  const file = await findByName(api, accessToken, rootFolderId, "_sync-meta.json");
  if (file) {
    try {
      const parsed = JSON.parse((await readRemote(api, accessToken, file.id)).text) as SyncMeta;
      parsed.files = Object.fromEntries(Object.entries(parsed.files ?? {}).filter(([, item]) => syncableDriveFile(item)));
      return parsed;
    } catch { /* rebuild below */ }
  }
  return metaFromFiles(await listRootFiles(api, accessToken, rootFolderId));
}

export async function writeSyncMeta(api: PluginAPI, accessToken: string, rootFolderId: string, meta: SyncMeta): Promise<void> {
  const file = await findByName(api, accessToken, rootFolderId, "_sync-meta.json");
  let files = meta.files;
  if (file) {
    try {
      const current = JSON.parse((await readRemote(api, accessToken, file.id)).text) as SyncMeta;
      const nativeFiles = Object.fromEntries(Object.entries(current.files ?? {}).filter(([, item]) => isGoogleWorkspaceFile(item)));
      files = { ...nativeFiles, ...files };
    } catch { /* replace malformed metadata with the valid snapshot */ }
  }
  const content = JSON.stringify({ ...meta, files }, null, 2);
  if (file) await updateRemote(api, accessToken, file.id, content, "application/json");
  else await createRemote(api, accessToken, rootFolderId, "_sync-meta.json", content, "application/json");
}
