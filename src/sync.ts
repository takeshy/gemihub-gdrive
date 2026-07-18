import { createConnection, refreshSession, unlockConnection, type Session, type StoredConnection } from "./auth";
import { createRemote, ensureFolder, listRootFiles, metaFromFiles, moveRemote, readRemote, readSyncMeta, renameRemote, syncablePath, updateRemote, writeSyncMeta } from "./drive";
import type { LocalSyncMeta, PluginAPI, ProjectFile, SyncMeta, SyncProgress, SyncStatus, SyncSummary } from "./types";

const CONNECTION_KEY = "connection";
const SNAPSHOT_KEY = "syncSnapshot";
const TEXT_MIME = new Set(["application/json", "application/javascript", "application/xml", "application/x-yaml", "application/yaml", "image/svg+xml"]);

function mimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return ({ md: "text/markdown", markdown: "text/markdown", txt: "text/plain", json: "application/json", html: "text/html", css: "text/css", js: "application/javascript", ts: "text/typescript", yaml: "application/x-yaml", yml: "application/x-yaml", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", epub: "application/epub+zip" } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function decodeDataURL(value: string): ArrayBuffer {
  const encoded = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function remoteIsBinary(mime: string): boolean { return !mime.startsWith("text/") && !TEXT_MIME.has(mime); }
function emptySnapshot(projectId: string): LocalSyncMeta { return { projectId, lastUpdatedAt: "", files: {}, pathToId: {} }; }
function sorted(values: Iterable<string>): string[] { return [...new Set(values)].sort((a, b) => a.localeCompare(b)); }

export async function parallelForEach<T>(items: T[], worker: (item: T) => Promise<void>, concurrency = 5): Promise<void> {
  let next = 0;
  let failure: unknown;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (failure === undefined) {
      const index = next++;
      if (index >= items.length) return;
      try { await worker(items[index]); }
      catch (error) { failure = error; }
    }
  });
  await Promise.all(runners);
  if (failure !== undefined) throw failure;
}

export function computeStatus(inventory: ProjectFile[], baseline: LocalSyncMeta, remote: SyncMeta): SyncStatus {
  const localByPath = new Map(inventory.map((file) => [file.path, file]));
  const remoteByName = new Map(Object.entries(remote.files).map(([id, file]) => [file.name, { id, file }]));
  const localChanges: string[] = [], remoteChanges: string[] = [], localOnly: string[] = [], remoteOnly: string[] = [], localDeletes: string[] = [], remoteDeletes: string[] = [], conflicts: string[] = [];

  for (const local of inventory) {
    const id = baseline.pathToId[local.path];
    if (!id) {
      const samePath = remoteByName.get(local.path);
      const rename = Object.entries(baseline.files).find(([candidateId, previous]) => previous.md5Checksum === local.md5 && !localByPath.has(previous.name) && remote.files[candidateId]);
      if (rename) localChanges.push(local.path);
      else if (!samePath) localOnly.push(local.path);
      else if (samePath.file.md5Checksum !== local.md5) conflicts.push(local.path);
      continue;
    }
    const previous = baseline.files[id];
    const currentRemote = remote.files[id];
    const localChanged = !previous || previous.md5Checksum !== local.md5 || previous.name !== local.path;
    const remoteChanged = !!previous && !!currentRemote && (previous.md5Checksum !== currentRemote.md5Checksum || previous.name.toLowerCase() !== currentRemote.name.toLowerCase());
    if (localChanged && remoteChanged) conflicts.push(local.path);
    else if (localChanged) localChanges.push(local.path);
    else if (remoteChanged) remoteChanges.push(currentRemote.name);
  }

  for (const [id, previous] of Object.entries(baseline.files)) {
    const hasLocal = localByPath.has(previous.name) || inventory.some((file) => baseline.pathToId[file.path] === id || (!baseline.pathToId[file.path] && file.md5 === previous.md5Checksum));
    const hasRemote = !!remote.files[id];
    if (!hasLocal && hasRemote) localDeletes.push(previous.name);
    if (hasLocal && !hasRemote) {
      const local = localByPath.get(previous.name);
      if (local && local.md5 !== previous.md5Checksum) conflicts.push(previous.name); else remoteDeletes.push(previous.name);
    }
  }
  for (const [id, file] of Object.entries(remote.files)) {
    if (!baseline.files[id] && !localByPath.has(file.name)) remoteOnly.push(file.name);
  }
  return { localChanges: sorted(localChanges), remoteChanges: sorted(remoteChanges), localOnly: sorted(localOnly), remoteOnly: sorted(remoteOnly), localDeletes: sorted(localDeletes), remoteDeletes: sorted(remoteDeletes), conflicts: sorted(conflicts) };
}

export class ProjectDriveSync {
  private session: Session | null = null;
  constructor(private api: PluginAPI) {
    if (!api.projectFiles || !api.storage || !api.network) throw new Error("This plugin requires projectFiles, storage, and network APIs from GemiHub Desktop.");
  }

  async connection(): Promise<StoredConnection | null> { return await this.api.storage!.get(CONNECTION_KEY) as StoredConnection | null; }
  async setup(token: string): Promise<StoredConnection> {
    const project = await this.api.projectFiles!.current();
    if (!project) throw new Error("Select a project before connecting Google Drive.");
    const connection = await createConnection(this.api, token, project);
    await this.api.storage!.set(CONNECTION_KEY, connection);
    await this.api.storage!.set(SNAPSHOT_KEY, null);
    return connection;
  }
  async reset(): Promise<void> { this.session = null; await this.api.storage!.set(CONNECTION_KEY, null); await this.api.storage!.set(SNAPSHOT_KEY, null); }
  async unlock(password: string): Promise<void> {
    const connection = await this.connection();
    if (!connection) throw new Error("Google Drive is not connected.");
    await this.assertProject(connection);
    this.session = await unlockConnection(this.api, connection, password);
  }
  private async assertProject(connection?: StoredConnection): Promise<StoredConnection> {
    const saved = connection ?? await this.connection();
    if (!saved) throw new Error("Google Drive is not connected.");
    const current = await this.api.projectFiles!.current();
    if (!current || current.id !== saved.project.id || current.path !== saved.project.path) throw new Error(`This connection belongs to project “${saved.project.name}”. Switch back to that project before syncing.`);
    return saved;
  }
  private async tokens(): Promise<Session> {
    await this.assertProject();
    if (!this.session) throw new Error("Unlock the connection first.");
    this.session = await refreshSession(this.api, this.session);
    return this.session;
  }
  private async snapshot(projectId: string): Promise<LocalSyncMeta> {
    const value = await this.api.storage!.get(SNAPSHOT_KEY) as LocalSyncMeta | null;
    return value?.projectId === projectId ? value : emptySnapshot(projectId);
  }
  private async inventory(): Promise<ProjectFile[]> { return (await this.api.projectFiles!.inventory()).filter((file) => syncablePath(file.path)); }
  private async state(): Promise<{ session: Session; inventory: ProjectFile[]; baseline: LocalSyncMeta; remote: SyncMeta; status: SyncStatus }> {
    const connection = await this.assertProject();
    const session = await this.tokens();
    const [inventory, baseline, remote] = await Promise.all([this.inventory(), this.snapshot(connection.project.id), readSyncMeta(this.api, session.accessToken, session.rootFolderId)]);
    return { session, inventory, baseline, remote, status: computeStatus(inventory, baseline, remote) };
  }
  async status(): Promise<SyncStatus> { return (await this.state()).status; }

  private async saveSnapshot(projectId: string, remote: SyncMeta, inventory: ProjectFile[]): Promise<void> {
    const localByPath = new Map(inventory.map((file) => [file.path, file]));
    const files: LocalSyncMeta["files"] = {}, pathToId: Record<string, string> = {};
    for (const [id, file] of Object.entries(remote.files)) {
      const local = localByPath.get(file.name);
      if (!local) continue;
      files[id] = { name: file.name, md5Checksum: file.md5Checksum || local.md5 };
      pathToId[file.name] = id;
    }
    await this.api.storage!.set(SNAPSHOT_KEY, { projectId, lastUpdatedAt: remote.lastUpdatedAt, files, pathToId } satisfies LocalSyncMeta);
  }

  async push(allowDeletes = false): Promise<SyncSummary> {
    const connection = await this.assertProject();
    const { session, inventory, baseline, remote, status } = await this.state();
    if (status.conflicts.length) throw new Error(`Resolve conflicts first: ${status.conflicts.join(", ")}`);
    if (status.remoteChanges.length || status.remoteOnly.length || status.remoteDeletes.length) throw new Error("Google Drive has pending changes. Pull before pushing.");
    if (status.localDeletes.length && !allowDeletes) throw new Error(`Push will move ${status.localDeletes.length} remote file(s) to GemiHub trash. Confirm deletion first.`);
    const summary: SyncSummary = { created: 0, updated: 0, renamed: 0, deleted: 0, skipped: 0 };
    const renamedIds = new Set<string>();
    const localPaths = new Set(inventory.map((file) => file.path));
    const missing = Object.entries(baseline.files).filter(([, file]) => !localPaths.has(file.name));
    for (const local of inventory) {
      let id = baseline.pathToId[local.path];
      if (!id) {
        const sameRemote = Object.entries(remote.files).find(([, file]) => file.name === local.path && file.md5Checksum === local.md5);
        if (sameRemote) id = sameRemote[0];
      }
      if (!id) {
        const renamed = missing.find(([candidateId, previous]) => previous.md5Checksum === local.md5 && remote.files[candidateId]);
        if (renamed) { id = renamed[0]; await renameRemote(this.api, session.accessToken, id, local.path); renamedIds.add(id); summary.renamed++; }
      }
      if (id && baseline.files[id]?.md5Checksum === local.md5 && baseline.files[id]?.name === local.path) { summary.skipped++; continue; }
      const raw = await this.api.projectFiles!.read(local.path);
      const content = local.binary ? decodeDataURL(raw) : raw;
      if (id && remote.files[id]) { await updateRemote(this.api, session.accessToken, id, content, mimeType(local.path)); summary.updated++; }
      else { await createRemote(this.api, session.accessToken, session.rootFolderId, local.path, content, mimeType(local.path)); summary.created++; }
    }
    if (status.localDeletes.length) {
      const trash = await ensureFolder(this.api, session.accessToken, session.rootFolderId, "trash");
      for (const path of status.localDeletes) {
        const id = baseline.pathToId[path];
        if (id && remote.files[id] && !renamedIds.has(id)) { await moveRemote(this.api, session.accessToken, id, session.rootFolderId, trash); summary.deleted++; }
      }
    }
    const nextRemote = metaFromFiles(await listRootFiles(this.api, session.accessToken, session.rootFolderId));
    await writeSyncMeta(this.api, session.accessToken, session.rootFolderId, nextRemote);
    await this.saveSnapshot(connection.project.id, nextRemote, await this.inventory());
    return summary;
  }

  async pull(allowDeletes = false, onProgress?: (progress: SyncProgress) => void): Promise<SyncSummary> {
    const connection = await this.assertProject();
    const { session, inventory, baseline, remote, status } = await this.state();
    if (status.conflicts.length) throw new Error(`Resolve conflicts first: ${status.conflicts.join(", ")}`);
    if (status.localChanges.length || status.localDeletes.length) throw new Error("The project has pending tracked changes. Push before pulling.");
    if (status.remoteDeletes.length && !allowDeletes) throw new Error(`Pull will delete ${status.remoteDeletes.length} local file(s). Confirm deletion first.`);
    const summary: SyncSummary = { created: 0, updated: 0, renamed: 0, deleted: 0, skipped: 0 };
    const localByPath = new Map(inventory.map((file) => [file.path, file]));
    const files = Object.entries(remote.files);
    let completed = 0;
    onProgress?.({ phase: "pull", completed, total: files.length });
    await parallelForEach(files, async ([id, file]) => {
      try {
        const previous = baseline.files[id];
        let local = localByPath.get(file.name);
        if (previous && previous.name !== file.name && localByPath.has(previous.name) && !local) {
          await this.api.projectFiles!.rename(previous.name, file.name); summary.renamed++;
          local = localByPath.get(previous.name);
        }
        if (local?.md5 === file.md5Checksum) summary.skipped++;
        else {
          const content = await readRemote(this.api, session.accessToken, id);
          const value = remoteIsBinary(file.mimeType) ? content.buffer : content.text;
          if (local) { await this.api.projectFiles!.update(file.name, value); summary.updated++; }
          else { await this.api.projectFiles!.create(file.name, value); summary.created++; }
        }
        completed++;
        onProgress?.({ phase: "pull", completed, total: files.length, path: file.name });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Pull failed for ${file.name}: ${detail}`);
      }
    });
    if (status.remoteDeletes.length) {
      let deleted = 0;
      onProgress?.({ phase: "delete", completed: deleted, total: status.remoteDeletes.length });
      for (const path of status.remoteDeletes) {
        await this.api.projectFiles!.delete(path); summary.deleted++; deleted++;
        onProgress?.({ phase: "delete", completed: deleted, total: status.remoteDeletes.length, path });
      }
    }
    onProgress?.({ phase: "snapshot", completed: 0, total: 1 });
    await this.saveSnapshot(connection.project.id, remote, await this.inventory());
    onProgress?.({ phase: "snapshot", completed: 1, total: 1 });
    return summary;
  }
}
