import { decryptHybridData, decryptPrivateKey } from "./crypto";
import { request } from "./transport";
import type { PluginAPI, Project } from "./types";

export interface StoredConnection {
  data: string;
  encryptedPrivateKey: string;
  salt: string;
  rootFolderId: string;
  project: Project;
}

export interface Session { accessToken: string; refreshToken: string; apiOrigin: string; rootFolderId: string; expiryTime: number }

export function decodeMigrationToken(token: string): { accessToken: string; rootFolderId: string } {
  const clean = token.trim();
  if (!clean || clean.length % 2 || !/^[0-9a-f]+$/i.test(clean)) throw new Error("Invalid GemiHub sync token.");
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16) ^ 0x5a;
  let parsed: { a?: unknown; r?: unknown };
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("Invalid GemiHub sync token payload."); }
  if (typeof parsed.a !== "string" || typeof parsed.r !== "string" || !parsed.a || !parsed.r) throw new Error("Invalid GemiHub sync token fields.");
  return { accessToken: parsed.a, rootFolderId: parsed.r };
}

async function driveJSON(api: PluginAPI, url: string, accessToken: string): Promise<unknown> {
  const response = await request(api, url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.status < 200 || response.status >= 300) throw new Error(`Google Drive request failed: HTTP ${response.status}`);
  return response.json;
}

export async function createConnection(api: PluginAPI, token: string, project: Project): Promise<StoredConnection> {
  const temporary = decodeMigrationToken(token);
  const query = encodeURIComponent(`name='_encrypted-auth.json' and '${temporary.rootFolderId}' in parents and trashed=false`);
  const listed = await driveJSON(api, `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)&pageSize=1`, temporary.accessToken) as { files?: Array<{ id: string }> };
  const id = listed.files?.[0]?.id;
  if (!id) throw new Error("_encrypted-auth.json was not found. Enable encryption in GemiHub, then generate a new sync token.");
  const response = await request(api, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: `Bearer ${temporary.accessToken}` } });
  if (response.status !== 200) throw new Error(`Could not read encrypted authentication: HTTP ${response.status}`);
  const auth = response.json as { data?: unknown; encryptedPrivateKey?: unknown; salt?: unknown };
  if (typeof auth.data !== "string" || typeof auth.encryptedPrivateKey !== "string" || typeof auth.salt !== "string") throw new Error("Invalid _encrypted-auth.json.");
  return { data: auth.data, encryptedPrivateKey: auth.encryptedPrivateKey, salt: auth.salt, rootFolderId: temporary.rootFolderId, project };
}

export async function unlockConnection(api: PluginAPI, connection: StoredConnection, password: string): Promise<Session> {
  let payload: { refreshToken?: unknown; apiOrigin?: unknown };
  try {
    const privateKey = await decryptPrivateKey(connection.encryptedPrivateKey, connection.salt, password);
    payload = JSON.parse(await decryptHybridData(connection.data, privateKey));
  } catch { throw new Error("Could not unlock Drive credentials. Check the GemiHub encryption password."); }
  if (typeof payload.refreshToken !== "string" || typeof payload.apiOrigin !== "string" || !payload.apiOrigin.startsWith("https://")) throw new Error("Encrypted Drive credentials are incomplete.");
  return refreshSession(api, { accessToken: "", refreshToken: payload.refreshToken, apiOrigin: payload.apiOrigin.replace(/\/$/, ""), rootFolderId: connection.rootFolderId, expiryTime: 0 });
}

export async function refreshSession(api: PluginAPI, session: Session): Promise<Session> {
  if (session.expiryTime - Date.now() > 5 * 60_000) return session;
  const response = await request(api, `${session.apiOrigin}/api/obsidian/token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: session.refreshToken, rootFolderId: session.rootFolderId }),
  });
  const body = response.json as { access_token?: unknown; expires_in?: unknown; error?: unknown };
  if (response.status < 200 || response.status >= 300 || typeof body.access_token !== "string") throw new Error(typeof body.error === "string" ? body.error : `Token refresh failed: HTTP ${response.status}`);
  return { ...session, accessToken: body.access_token, expiryTime: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000 };
}
