import React, { useEffect, useMemo, useState } from "react";
import { ProjectDriveSync } from "./sync";
import type { ConflictInfo, PluginAPI, SyncProgress, SyncStatus, SyncSummary } from "./types";

function summary(value: SyncSummary): string {
  return `created ${value.created}, updated ${value.updated}, renamed ${value.renamed}, deleted ${value.deleted}, skipped ${value.skipped}`;
}

function countStatus(value: SyncStatus): string {
  return `${value.localChanges.length + value.localOnly.length} local, ${value.remoteChanges.length + value.remoteOnly.length} remote, ${value.conflicts.length} conflicts`;
}

type PreviewDirection = "push" | "pull";
type PreviewItem = { path: string; type: "new" | "modified" | "deleted" | "conflict" };

function previewItems(status: SyncStatus, direction: PreviewDirection): PreviewItem[] {
  const items = new Map<string, PreviewItem["type"]>();
  const add = (paths: string[], type: PreviewItem["type"]) => paths.forEach((path) => items.set(path, type));
  if (direction === "push") {
    add(status.localOnly, "new"); add(status.localChanges, "modified"); add(status.localDeletes, "deleted");
  } else {
    add(status.remoteOnly, "new"); add(status.remoteChanges, "modified"); add(status.remoteDeletes, "deleted");
  }
  add(status.conflicts.map((conflict) => conflict.path), "conflict");
  return [...items].map(([path, type]) => ({ path, type })).sort((a, b) => a.path.localeCompare(b.path));
}

function previewBlockReason(status: SyncStatus, direction: PreviewDirection): string | null {
  if (status.conflicts.length) return "Resolve the conflicts above before syncing.";
  if (direction === "push" && (status.remoteChanges.length || status.remoteOnly.length || status.remoteDeletes.length)) return "Drive has pending changes. Pull before pushing.";
  return null;
}

function conflictLabel(kind: ConflictInfo["kind"]): string {
  if (kind === "localEditRemoteDelete") return "edited here, deleted on Drive";
  if (kind === "localDeleteRemoteEdit") return "deleted here, edited on Drive";
  if (kind === "untracked") return "different content on both sides";
  return "edited on both sides";
}

export function DriveSyncView({ api }: { api: PluginAPI }) {
  const client = useMemo(() => {
    try { return new ProjectDriveSync(api); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }, [api]);
  const [connection, setConnection] = useState<Awaited<ReturnType<ProjectDriveSync["connection"]>>>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [preview, setPreview] = useState<PreviewDirection | null>(null);

  useEffect(() => {
    if (typeof client === "string") return;
    void client.connection().then(setConnection).catch((error) => setMessage(String(error)));
  }, [client]);

  if (typeof client === "string") return <section className="gdrive-sync">
    <header><span className="gdrive-logo">G</span><div><strong>Google Drive Sync</strong><small>GemiHub-compatible project sync</small></div></header>
    <p className="gdrive-message danger">{client}</p>
  </section>;

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage(""); setProgress(null);
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); setProgress(null); }
  };

  const refresh = async () => {
    const next = await client.status();
    setStatus(next); setPreview(null); setMessage(countStatus(next));
  };

  const prepare = async (direction: PreviewDirection) => {
    const next = await client.status();
    setStatus(next); setPreview(direction); setMessage(countStatus(next));
  };

  const push = async () => {
    const next = await client.status(); setStatus(next);
    const deletions = next.localDeletes.length;
    if (deletions && !window.confirm(`Push will move ${deletions} file(s) to GemiHub trash. Continue?`)) return;
    setMessage(`Push complete: ${summary(await client.push(deletions > 0))}`);
    setStatus(await client.status()); setPreview(null);
  };

  const pull = async () => {
    const next = await client.status(); setStatus(next);
    const deletions = next.remoteDeletes.length;
    if (deletions && !window.confirm(`Pull will delete ${deletions} local project file(s). Continue?`)) return;
    setMessage(`Pull complete: ${summary(await client.pull(deletions > 0, setProgress))}`);
    setStatus(await client.status()); setPreview(null);
  };

  const resolve = async (targets: ConflictInfo[], choice: "local" | "remote") => {
    const resolved = await client.resolveConflicts(targets.map((conflict) => ({ conflict, choice })));
    const next = await client.status(); setStatus(next);
    setMessage(`Resolved ${resolved} conflict(s); the other side was backed up to sync_conflicts/ on Drive. ${countStatus(next)}`);
  };

  return <section className="gdrive-sync">
    <header><span className="gdrive-logo">G</span><div><strong>Google Drive Sync</strong><small>GemiHub-compatible project sync</small></div></header>
    {!connection ? <div className="gdrive-form">
      <p>GemiHubで暗号化を有効にし、設定 → 同期 → 外部同期から同期トークンを生成してください。現在選択中のproject全体がこの接続に固定されます。</p>
      <label><span>GemiHub sync token</span><textarea rows={5} value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} /></label>
      <button type="button" disabled={busy || !token.trim()} onClick={() => void run(async () => { const saved = await client.setup(token); setConnection(saved); setToken(""); setMessage(`Connected to project “${saved.project.name}”.`); })}>Connect project</button>
    </div> : !unlocked ? <div className="gdrive-form">
      <p>接続先project: <strong>{connection.project.name}</strong></p>
      <label><span>GemiHub encryption password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></label>
      <button type="button" disabled={busy || !password} onClick={() => void run(async () => { await client.unlock(password); setPassword(""); setUnlocked(true); setMessage("Drive connection unlocked for this session."); })}>Unlock</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => { await client.reset(); setConnection(null); setStatus(null); setMessage("Connection reset."); })}>Reset connection</button>
    </div> : <div className="gdrive-actions">
      <div className="gdrive-project"><span>Project</span><strong>{connection.project.name}</strong><small>{connection.project.path}</small></div>
      {status && <div className="gdrive-status-grid">
        <span>Local changes <b>{status.localChanges.length + status.localOnly.length}</b></span>
        <span>Remote changes <b>{status.remoteChanges.length + status.remoteOnly.length}</b></span>
        <span>Push deletes <b>{status.localDeletes.length}</b></span>
        <span>Pull deletes <b>{status.remoteDeletes.length}</b></span>
        <span className={status.conflicts.length ? "danger" : ""}>Conflicts <b>{status.conflicts.length}</b></span>
      </div>}
      {status?.conflicts.length ? <div className="gdrive-preview gdrive-conflicts">
        <div className="gdrive-preview-header"><strong>Conflicts</strong><span>{status.conflicts.length} file(s)</span></div>
        <p>Choose which side to keep for each file. The other side is backed up to <code>sync_conflicts/</code> on Drive.</p>
        <ul>{status.conflicts.map((conflict) => <li key={conflict.path} className="is-conflict">
          <div className="gdrive-conflict-file"><span>{conflict.path}</span><small>{conflictLabel(conflict.kind)}</small></div>
          <div className="gdrive-conflict-buttons">
            <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => resolve([conflict], "local"))}>Keep local</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => resolve([conflict], "remote"))}>Keep remote</button>
          </div>
        </li>)}</ul>
        <div className="gdrive-preview-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => resolve(status.conflicts, "local"))}>Keep all local</button>
          <button type="button" disabled={busy} onClick={() => void run(() => resolve(status.conflicts, "remote"))}>Keep all remote</button>
        </div>
      </div> : null}
      {status && preview ? <div className="gdrive-preview">
        <div className="gdrive-preview-header"><strong>{preview === "push" ? "Push to Drive" : "Pull to project"}</strong><span>{previewItems(status, preview).length} file(s)</span></div>
        {previewItems(status, preview).length ? <ul>{previewItems(status, preview).map((item) => <li key={`${item.type}:${item.path}`} className={`is-${item.type}`}><span className="gdrive-preview-type">{item.type}</span><span>{item.path}</span></li>)}</ul> : <p>No files to sync.</p>}
        {previewBlockReason(status, preview) ? <p className="danger">{previewBlockReason(status, preview)}</p> : null}
        <div className="gdrive-preview-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
          <button type="button" disabled={busy || !!previewBlockReason(status, preview)} onClick={() => void run(preview === "push" ? push : pull)}>{preview === "push" ? "Push" : "Pull"}</button>
        </div>
      </div> : null}
      <div className="gdrive-buttons">
        <button type="button" disabled={busy} onClick={() => void run(refresh)}>Check</button>
        <button type="button" disabled={busy} onClick={() => void run(() => prepare("pull"))}>Pull</button>
        <button type="button" disabled={busy} onClick={() => void run(() => prepare("push"))}>Push</button>
      </div>
      <small>GemiHubと同じ `_sync-meta.json` を使用します。初回に両側へ異なるファイルがある場合は Pull → Push の順で統合してください。</small>
    </div>}
    {busy && <p className="gdrive-message">{progress ? `${progress.phase === "pull" ? "Pull" : progress.phase === "delete" ? "Delete" : "Snapshot"} ${progress.completed} / ${progress.total}${progress.path ? `: ${progress.path}` : ""}` : "Working…"}</p>}
    {message && <p className="gdrive-message">{message}</p>}
  </section>;
}
