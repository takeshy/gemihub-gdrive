import React, { useEffect, useMemo, useState } from "react";
import { ProjectDriveSync } from "./sync";
import type { PluginAPI, SyncProgress, SyncStatus, SyncSummary } from "./types";

function summary(value: SyncSummary): string {
  return `created ${value.created}, updated ${value.updated}, renamed ${value.renamed}, deleted ${value.deleted}, skipped ${value.skipped}`;
}

function countStatus(value: SyncStatus): string {
  return `${value.localChanges.length + value.localOnly.length} local, ${value.remoteChanges.length + value.remoteOnly.length} remote, ${value.conflicts.length} conflicts`;
}

export function DriveSyncView({ api }: { api: PluginAPI }) {
  const client = useMemo(() => new ProjectDriveSync(api), [api]);
  const [connection, setConnection] = useState<Awaited<ReturnType<ProjectDriveSync["connection"]>>>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<SyncProgress | null>(null);

  useEffect(() => { void client.connection().then(setConnection).catch((error) => setMessage(String(error))); }, [client]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage(""); setProgress(null);
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); setProgress(null); }
  };

  const refresh = async () => {
    const next = await client.status();
    setStatus(next); setMessage(countStatus(next));
  };

  const push = async () => {
    const next = await client.status(); setStatus(next);
    const deletions = next.localDeletes.length;
    if (deletions && !window.confirm(`Push will move ${deletions} file(s) to GemiHub trash. Continue?`)) return;
    setMessage(`Push complete: ${summary(await client.push(deletions > 0))}`);
    setStatus(await client.status());
  };

  const pull = async () => {
    const next = await client.status(); setStatus(next);
    const deletions = next.remoteDeletes.length;
    if (deletions && !window.confirm(`Pull will delete ${deletions} local project file(s). Continue?`)) return;
    setMessage(`Pull complete: ${summary(await client.pull(deletions > 0, setProgress))}`);
    setStatus(await client.status());
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
      {status?.conflicts.length ? <details><summary>Conflicting paths</summary><ul>{status.conflicts.map((path) => <li key={path}>{path}</li>)}</ul></details> : null}
      <div className="gdrive-buttons">
        <button type="button" disabled={busy} onClick={() => void run(refresh)}>Check</button>
        <button type="button" disabled={busy} onClick={() => void run(pull)}>Pull</button>
        <button type="button" disabled={busy} onClick={() => void run(push)}>Push</button>
      </div>
      <small>GemiHubと同じ `_sync-meta.json` を使用します。初回に両側へ異なるファイルがある場合は Pull → Push の順で統合してください。</small>
    </div>}
    {busy && <p className="gdrive-message">{progress ? `${progress.phase === "pull" ? "Pull" : progress.phase === "delete" ? "Delete" : "Snapshot"} ${progress.completed} / ${progress.total}${progress.path ? `: ${progress.path}` : ""}` : "Working…"}</p>}
    {message && <p className="gdrive-message">{message}</p>}
  </section>;
}
