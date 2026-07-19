import { createConnection, refreshSession, unlockConnection, type Session, type StoredConnection } from "./auth";
import { createRemote, ensureFolder, listRootFiles, metaFromFiles, moveRemote, readRemote, readSyncMeta, renameRemote, saveConflictBackup, syncablePath, updateRemote, writeSyncMeta } from "./drive";
import type { ConflictInfo, LocalSyncMeta, PluginAPI, Project, ProjectFile, SyncMeta, SyncProgress, SyncStatus, SyncSummary, WorkspaceFilesAPI } from "./types";

const CONNECTION_KEY = "connection";
const SNAPSHOT_KEY = "syncSnapshot";
const TEXT_MIME = new Set(["application/json", "application/javascript", "application/xml", "application/x-yaml", "application/yaml", "image/svg+xml"]);

function mimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return ({ md: "text/markdown", markdown: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json", html: "text/html", css: "text/css", js: "application/javascript", ts: "text/typescript", xml: "application/xml", yaml: "application/x-yaml", yml: "application/x-yaml", base: "text/plain", kanban: "text/plain", dashboard: "text/plain", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", epub: "application/epub+zip" } as Record<string, string>)[extension] ?? "application/octet-stream";
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

function resolveLocalIds(inventory: ProjectFile[], baseline: LocalSyncMeta): Map<string, string> {
  const resolved = new Map<string, string>();
  const claimedIds = new Set<string>();

  // Exact paths are unambiguous, even when several files have the same checksum.
  for (const local of inventory) {
    const id = baseline.pathToId[local.path];
    if (id && baseline.files[id]) { resolved.set(local.path, id); claimedIds.add(id); }
  }

  // A checksum-preserving rename is safe only when the remaining old and new
  // paths form a one-to-one match. This avoids guessing between empty or
  // duplicate-content files.
  const oldByChecksum = new Map<string, string[]>();
  for (const [id, previous] of Object.entries(baseline.files)) {
    if (claimedIds.has(id) || inventory.some((file) => file.path === previous.name)) continue;
    const ids = oldByChecksum.get(previous.md5Checksum) ?? [];
    ids.push(id); oldByChecksum.set(previous.md5Checksum, ids);
  }
  const localByChecksum = new Map<string, ProjectFile[]>();
  for (const local of inventory) {
    if (resolved.has(local.path)) continue;
    const files = localByChecksum.get(local.md5) ?? [];
    files.push(local); localByChecksum.set(local.md5, files);
  }
  for (const [checksum, ids] of oldByChecksum) {
    const locals = localByChecksum.get(checksum) ?? [];
    if (ids.length === 1 && locals.length === 1) resolved.set(locals[0].path, ids[0]);
  }
  return resolved;
}

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

/**
 * Snapshot of the last known synchronized state. A remote entry is adopted only
 * when the local file matches it; otherwise the previous baseline entry is kept
 * so pending local edits, renames, deletes, and unresolved conflicts survive a
 * pull or a partial conflict resolution.
 */
export function computeSnapshot(projectId: string, remote: SyncMeta, inventory: ProjectFile[], baseline: LocalSyncMeta): LocalSyncMeta {
  const localByPath = new Map(inventory.map((file) => [file.path, file]));
  const files: LocalSyncMeta["files"] = {}, pathToId: Record<string, string> = {};
  for (const [id, file] of Object.entries(remote.files)) {
    const local = localByPath.get(file.name);
    const previous = baseline.files[id];
    let entry: LocalSyncMeta["files"][string] | undefined;
    if (local && (!file.md5Checksum || local.md5 === file.md5Checksum)) entry = { name: file.name, md5Checksum: file.md5Checksum || local.md5 };
    else if (previous) entry = previous;
    if (!entry) continue;
    files[id] = entry; pathToId[entry.name] = id;
  }
  return { projectId, lastUpdatedAt: remote.lastUpdatedAt, files, pathToId };
}

export interface PushAction { local: ProjectFile; id: string | undefined; rename: boolean; upload: "create" | "update" | null }

export interface ConflictPreview {
  binary: boolean;
  local: { exists: boolean; name: string; size?: number; md5?: string; text?: string };
  remote: { exists: boolean; name: string; size?: number; md5?: string; text?: string };
}

export function planPush(inventory: ProjectFile[], baseline: LocalSyncMeta, remote: SyncMeta): PushAction[] {
  const localIds = resolveLocalIds(inventory, baseline);
  return inventory.map((local) => {
    let id = localIds.get(local.path);
    if (!id) {
      const sameRemote = Object.entries(remote.files).filter(([, file]) => file.name === local.path && file.md5Checksum === local.md5);
      if (sameRemote.length === 1) id = sameRemote[0][0];
    }
    // For untracked files adopted through a name+checksum match the remote file
    // itself is the last known state; comparing against the (empty) baseline
    // would re-upload and re-name identical content on the first push.
    const known = id ? baseline.files[id] ?? remote.files[id] : undefined;
    const rename = !!id && !!remote.files[id] && !!known && known.name !== local.path;
    const upload: PushAction["upload"] = id && known && known.md5Checksum === local.md5 ? null : id && remote.files[id] ? "update" : "create";
    return { local, id, rename, upload };
  });
}

export function computeStatus(inventory: ProjectFile[], baseline: LocalSyncMeta, remote: SyncMeta): SyncStatus {
  const localByPath = new Map(inventory.map((file) => [file.path, file]));
  const remoteByName = new Map(Object.entries(remote.files).map(([id, file]) => [file.name, { id, file }]));
  const localIds = resolveLocalIds(inventory, baseline);
  const localById = new Map([...localIds].map(([path, id]) => [id, localByPath.get(path)!]));
  const localChanges: string[] = [], remoteChanges: string[] = [], localOnly: string[] = [], remoteOnly: string[] = [], localDeletes: string[] = [], remoteDeletes: string[] = [];
  const conflicts: ConflictInfo[] = [];

  for (const local of inventory) {
    const id = localIds.get(local.path);
    if (!id) {
      const samePath = remoteByName.get(local.path);
      if (!samePath) localOnly.push(local.path);
      else if (samePath.file.md5Checksum !== local.md5) conflicts.push({ path: local.path, id: samePath.id, remoteName: samePath.file.name, kind: "untracked" });
      continue;
    }
    const previous = baseline.files[id];
    const currentRemote = remote.files[id];
    if (currentRemote && currentRemote.md5Checksum === local.md5 && currentRemote.name === local.path) continue;
    const localChanged = !previous || previous.md5Checksum !== local.md5 || previous.name !== local.path;
    const remoteChanged = !!previous && !!currentRemote && (previous.md5Checksum !== currentRemote.md5Checksum || previous.name !== currentRemote.name);
    if (!currentRemote) {
      if (localChanged) conflicts.push({ path: local.path, id, remoteName: null, kind: "localEditRemoteDelete" }); else remoteDeletes.push(previous.name);
    } else if (localChanged && remoteChanged) conflicts.push({ path: local.path, id, remoteName: currentRemote.name, kind: "edit" });
    else if (localChanged) localChanges.push(local.path);
    else if (remoteChanged) remoteChanges.push(currentRemote.name);
  }

  for (const [id, previous] of Object.entries(baseline.files)) {
    if (localById.has(id)) continue;
    const currentRemote = remote.files[id];
    if (!currentRemote) continue;
    const remoteChanged = previous.md5Checksum !== currentRemote.md5Checksum || previous.name !== currentRemote.name;
    if (remoteChanged) conflicts.push({ path: previous.name, id, remoteName: currentRemote.name, kind: "localDeleteRemoteEdit" }); else localDeletes.push(previous.name);
  }
  for (const [id, file] of Object.entries(remote.files)) {
    if (!baseline.files[id] && !localByPath.has(file.name)) remoteOnly.push(file.name);
  }
  return { localChanges: sorted(localChanges), remoteChanges: sorted(remoteChanges), localOnly: sorted(localOnly), remoteOnly: sorted(remoteOnly), localDeletes: sorted(localDeletes), remoteDeletes: sorted(remoteDeletes), conflicts: conflicts.sort((a, b) => a.path.localeCompare(b.path)) };
}

export class ProjectDriveSync {
  private session: Session | null = null;
  private selectedFiles: WorkspaceFilesAPI | null = null;
  constructor(private api: PluginAPI) {
    if ((!api.files && !api.projectFiles) || !api.storage || !api.network) throw new Error("This plugin requires Workspace files, storage, and network APIs from GemiHub Desktop.");
  }

  private async workspaceFiles(expected?: Project): Promise<WorkspaceFilesAPI> {
    if (this.selectedFiles) return this.selectedFiles;
    const available: Array<{ files: WorkspaceFilesAPI; current: Project }> = [];
    for (const files of [this.api.files, this.api.projectFiles]) {
      if (!files || typeof files.current !== "function" || typeof files.inventory !== "function") continue;
      const current = await files.current();
      if (current) available.push({ files, current });
    }
    const selected = expected
      ? available.find(({ current }) => current.id === expected.id && current.path === expected.path)
      : available[0];
    if (!selected) throw new Error("Select a Workspace before connecting Google Drive.");
    this.selectedFiles = selected.files;
    return selected.files;
  }

  async connection(): Promise<StoredConnection | null> { return await this.api.storage!.get(CONNECTION_KEY) as StoredConnection | null; }
  async setup(token: string): Promise<StoredConnection> {
    const project = await (await this.workspaceFiles()).current();
    if (!project) throw new Error("Select a Workspace before connecting Google Drive.");
    const connection = await createConnection(this.api, token, project);
    await this.api.storage!.set(CONNECTION_KEY, connection);
    await this.api.storage!.set(SNAPSHOT_KEY, null);
    return connection;
  }
  async reset(): Promise<void> { this.session = null; this.selectedFiles = null; await this.api.storage!.set(CONNECTION_KEY, null); await this.api.storage!.set(SNAPSHOT_KEY, null); }
  async unlock(password: string): Promise<void> {
    const connection = await this.connection();
    if (!connection) throw new Error("Google Drive is not connected.");
    await this.assertProject(connection);
    this.session = await unlockConnection(this.api, connection, password);
  }
  private async assertProject(connection?: StoredConnection): Promise<StoredConnection> {
    const saved = connection ?? await this.connection();
    if (!saved) throw new Error("Google Drive is not connected.");
    const current = await (await this.workspaceFiles(saved.project)).current();
    if (!current) throw new Error("Select a Workspace before syncing.");
    if (current.id !== saved.project.id || current.path !== saved.project.path) {
      // Desktop formerly exposed its compatibility project (id "project",
      // name "Workspace") to this plugin. Migrate only that known legacy
      // shape; real named project connections still require an explicit reset.
      if (saved.project.id === "project" && saved.project.name === "Workspace") {
        const migrated = { ...saved, project: current };
        await this.api.storage!.set(CONNECTION_KEY, migrated);
        await this.api.storage!.set(SNAPSHOT_KEY, null);
        return migrated;
      }
      throw new Error(`This connection belongs to Workspace “${saved.project.name}”. Switch back to that Workspace before syncing, or reset the connection.`);
    }
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
  private async inventory(): Promise<ProjectFile[]> { return (await (await this.workspaceFiles()).inventory()).filter((file) => syncablePath(file.path)); }
  private async state(): Promise<{ session: Session; inventory: ProjectFile[]; baseline: LocalSyncMeta; remote: SyncMeta; status: SyncStatus }> {
    const connection = await this.assertProject();
    const session = await this.tokens();
    const [inventory, baseline, remote] = await Promise.all([this.inventory(), this.snapshot(connection.project.id), readSyncMeta(this.api, session.accessToken, session.rootFolderId)]);
    return { session, inventory, baseline, remote, status: computeStatus(inventory, baseline, remote) };
  }
  async status(): Promise<SyncStatus> { return (await this.state()).status; }

  /** Read both sides of a current conflict without changing either side. */
  async conflictPreview(requested: ConflictInfo): Promise<ConflictPreview> {
    const connection = await this.assertProject();
    const files = await this.workspaceFiles(connection.project);
    const { session, inventory, remote, status } = await this.state();
    const conflict = status.conflicts.find((item) => item.path === requested.path && item.kind === requested.kind);
    if (!conflict) throw new Error("This conflict is no longer current. Run Check again.");

    const local = inventory.find((file) => file.path === conflict.path);
    const remoteFile = remote.files[conflict.id];
    const binary = Boolean(local?.binary || (remoteFile && remoteIsBinary(remoteFile.mimeType)));
    const preview: ConflictPreview = {
      binary,
      local: { exists: !!local, name: conflict.path, size: local?.size, md5: local?.md5 },
      remote: {
        exists: !!remoteFile,
        name: remoteFile?.name ?? conflict.remoteName ?? conflict.path,
        size: remoteFile?.size ? Number(remoteFile.size) : undefined,
        md5: remoteFile?.md5Checksum,
      },
    };
    if (!binary) {
      if (local) preview.local.text = await files.read(conflict.path);
      if (remoteFile) preview.remote.text = (await readRemote(this.api, session.accessToken, conflict.id)).text;
    }
    return preview;
  }

  private async saveSnapshot(projectId: string, remote: SyncMeta, inventory: ProjectFile[], baseline: LocalSyncMeta): Promise<void> {
    await this.api.storage!.set(SNAPSHOT_KEY, computeSnapshot(projectId, remote, inventory, baseline));
  }

  async push(allowDeletes = false): Promise<SyncSummary> {
    const connection = await this.assertProject();
    const files = await this.workspaceFiles(connection.project);
    const { session, inventory, baseline, remote, status } = await this.state();
    if (status.conflicts.length) throw new Error(`Resolve conflicts first: ${status.conflicts.map((conflict) => conflict.path).join(", ")}`);
    if (status.remoteChanges.length || status.remoteOnly.length || status.remoteDeletes.length) throw new Error("Google Drive has pending changes. Pull before pushing.");
    if (status.localDeletes.length && !allowDeletes) throw new Error(`Push will move ${status.localDeletes.length} remote file(s) to GemiHub trash. Confirm deletion first.`);
    const summary: SyncSummary = { created: 0, updated: 0, renamed: 0, deleted: 0, skipped: 0 };
    const renamedIds = new Set<string>();
    for (const action of planPush(inventory, baseline, remote)) {
      const { local, id } = action;
      if (action.rename && id) {
        await renameRemote(this.api, session.accessToken, id, local.path);
        renamedIds.add(id); summary.renamed++;
      }
      if (!action.upload) {
        if (!id || !renamedIds.has(id)) summary.skipped++;
        continue;
      }
      const raw = await files.read(local.path);
      const content = local.binary ? decodeDataURL(raw) : raw;
      if (action.upload === "update" && id) { await updateRemote(this.api, session.accessToken, id, content, mimeType(local.path)); summary.updated++; }
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
    const writtenRemote = await writeSyncMeta(this.api, session.accessToken, session.rootFolderId, nextRemote);
    await this.saveSnapshot(connection.project.id, writtenRemote, await this.inventory(), baseline);
    return summary;
  }

  async pull(allowDeletes = false, onProgress?: (progress: SyncProgress) => void): Promise<SyncSummary> {
    const connection = await this.assertProject();
    const workspaceFiles = await this.workspaceFiles(connection.project);
    const { session, inventory, baseline, remote, status } = await this.state();
    if (status.conflicts.length) throw new Error(`Resolve conflicts first: ${status.conflicts.map((conflict) => conflict.path).join(", ")}`);
    if (status.remoteDeletes.length && !allowDeletes) throw new Error(`Pull will delete ${status.remoteDeletes.length} local file(s). Confirm deletion first.`);
    const summary: SyncSummary = { created: 0, updated: 0, renamed: 0, deleted: 0, skipped: 0 };
    const localByPath = new Map(inventory.map((file) => [file.path, file]));
    const files = Object.entries(remote.files);
    let completed = 0;
    onProgress?.({ phase: "pull", completed, total: files.length });
    await parallelForEach(files, async ([id, file]) => {
      try {
        const previous = baseline.files[id];
        // A remote file unchanged since the baseline has nothing to pull;
        // leave the local side alone so pending local edits, renames, and
        // deletes survive until the next push.
        if (previous && previous.md5Checksum === file.md5Checksum && previous.name === file.name) {
          summary.skipped++;
          completed++;
          onProgress?.({ phase: "pull", completed, total: files.length, path: file.name });
          return;
        }
        let local = localByPath.get(file.name);
        if (previous && previous.name !== file.name && localByPath.has(previous.name) && !local) {
          await workspaceFiles.rename(previous.name, file.name); summary.renamed++;
          local = localByPath.get(previous.name);
        }
        if (local?.md5 === file.md5Checksum) summary.skipped++;
        else {
          const content = await readRemote(this.api, session.accessToken, id);
          const value = remoteIsBinary(file.mimeType) ? content.buffer : content.text;
          if (local) { await workspaceFiles.update(file.name, value); summary.updated++; }
          else { await workspaceFiles.create(file.name, value); summary.created++; }
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
        await workspaceFiles.delete(path); summary.deleted++; deleted++;
        onProgress?.({ phase: "delete", completed: deleted, total: status.remoteDeletes.length, path });
      }
    }
    onProgress?.({ phase: "snapshot", completed: 0, total: 1 });
    await this.saveSnapshot(connection.project.id, remote, await this.inventory(), baseline);
    onProgress?.({ phase: "snapshot", completed: 1, total: 1 });
    return summary;
  }

  /**
   * Resolve conflicts per file by choosing the surviving side, the same way the
   * GemiHub Obsidian plugin does: the losing side is backed up to the Drive
   * `sync_conflicts/` folder before it is overwritten or deleted.
   */
  async resolveConflicts(resolutions: Array<{ conflict: ConflictInfo; choice: "local" | "remote" }>): Promise<number> {
    const connection = await this.assertProject();
    const files = await this.workspaceFiles(connection.project);
    const { session, inventory, baseline, remote, status } = await this.state();
    const current = new Map(status.conflicts.map((conflict) => [conflict.path, conflict]));
    const localByPath = new Map(inventory.map((file) => [file.path, file]));
    let touchedRemote = false;
    let resolved = 0;

    const readLocal = async (path: string): Promise<string | ArrayBuffer> => {
      const raw = await files.read(path);
      return localByPath.get(path)?.binary ? decodeDataURL(raw) : raw;
    };
    const writeLocal = async (path: string, value: string | ArrayBuffer): Promise<void> => {
      if (localByPath.has(path)) await files.update(path, value);
      else await files.create(path, value);
    };

    for (const { conflict: requested, choice } of resolutions) {
      const conflict = current.get(requested.path);
      if (!conflict || conflict.kind !== requested.kind) continue;
      const remoteFile = remote.files[conflict.id];

      if (conflict.kind === "localEditRemoteDelete") {
        if (choice === "local") {
          await createRemote(this.api, session.accessToken, session.rootFolderId, conflict.path, await readLocal(conflict.path), mimeType(conflict.path));
          touchedRemote = true;
        } else {
          await saveConflictBackup(this.api, session.accessToken, session.rootFolderId, conflict.path, await readLocal(conflict.path), mimeType(conflict.path));
          await files.delete(conflict.path);
        }
      } else if (conflict.kind === "localDeleteRemoteEdit") {
        if (!remoteFile) continue;
        if (choice === "local") {
          const trash = await ensureFolder(this.api, session.accessToken, session.rootFolderId, "trash");
          await moveRemote(this.api, session.accessToken, conflict.id, session.rootFolderId, trash);
          touchedRemote = true;
        } else {
          const content = await readRemote(this.api, session.accessToken, conflict.id);
          await writeLocal(remoteFile.name, remoteIsBinary(remoteFile.mimeType) ? content.buffer : content.text);
        }
      } else { // "edit" | "untracked": both sides exist
        if (!remoteFile) continue;
        if (choice === "local") {
          const backup = await readRemote(this.api, session.accessToken, conflict.id);
          await saveConflictBackup(this.api, session.accessToken, session.rootFolderId, remoteFile.name, remoteIsBinary(remoteFile.mimeType) ? backup.buffer : backup.text, remoteFile.mimeType);
          if (remoteFile.name !== conflict.path) await renameRemote(this.api, session.accessToken, conflict.id, conflict.path);
          await updateRemote(this.api, session.accessToken, conflict.id, await readLocal(conflict.path), mimeType(conflict.path));
          touchedRemote = true;
        } else {
          await saveConflictBackup(this.api, session.accessToken, session.rootFolderId, conflict.path, await readLocal(conflict.path), mimeType(conflict.path));
          const content = await readRemote(this.api, session.accessToken, conflict.id);
          if (remoteFile.name !== conflict.path) await files.delete(conflict.path);
          await writeLocal(remoteFile.name, remoteIsBinary(remoteFile.mimeType) ? content.buffer : content.text);
        }
      }
      resolved++;
    }

    let finalRemote = remote;
    if (touchedRemote) {
      const nextRemote = metaFromFiles(await listRootFiles(this.api, session.accessToken, session.rootFolderId));
      finalRemote = await writeSyncMeta(this.api, session.accessToken, session.rootFolderId, nextRemote);
    }
    await this.saveSnapshot(connection.project.id, finalRemote, await this.inventory(), baseline);
    return resolved;
  }
}
