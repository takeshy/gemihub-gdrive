import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { sharedClient } from "./client";
import type { ConflictPreview } from "./sync";
import type { PluginAPI } from "./types";
import { lineDiff, splitDiffRows, type DiffLine } from "./diff";

type DiffViewMode = "unified" | "split";

function formatSize(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024, unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index++) {
    size /= 1024; unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

export function DriveComparison({ value }: { value: ConflictPreview }) {
  const [viewMode, setViewMode] = useState<DiffViewMode>("unified");
  if (value.binary) return <div className="gdrive-conflict-comparison">
    <p>Binary files cannot be displayed as text. Compare their file information below.</p>
    <div className="gdrive-binary-comparison">
      <strong>Local</strong><span>{value.local.exists ? value.local.name : "Deleted"}</span><span>{formatSize(value.local.size)}</span><code>{value.local.md5 || "—"}</code>
      <strong>Drive</strong><span>{value.remote.exists ? value.remote.name : "Deleted"}</span><span>{formatSize(value.remote.size)}</span><code>{value.remote.md5 || "—"}</code>
    </div>
  </div>;

  const lines = lineDiff(value.local.text ?? "", value.remote.text ?? "");
  return <div className="gdrive-conflict-comparison">
    <div className="gdrive-diff-toolbar">
      <div className="gdrive-diff-heading"><span>Local: {value.local.exists ? value.local.name : "Deleted"}</span><span>Drive: {value.remote.exists ? value.remote.name : "Deleted"}</span></div>
      <div className="gdrive-diff-mode" aria-label="Diff layout">
        <button type="button" className={viewMode === "unified" ? "active" : ""} onClick={() => setViewMode("unified")}>Unified</button>
        <button type="button" className={viewMode === "split" ? "active" : ""} onClick={() => setViewMode("split")}>Split</button>
      </div>
    </div>
    {viewMode === "unified" ? <UnifiedDiff lines={lines} /> : <SplitDiff lines={lines} />}
  </div>;
}

function UnifiedDiff({ lines }: { lines: DiffLine[] }) {
  return <div className="gdrive-diff" role="table" aria-label="Unified local to Drive differences">
    {lines.map((line, index) => line.kind === "gap"
      ? <div className="gdrive-diff-gap" key={`gap:${index}`}>⋯ {line.text} ⋯</div>
      : <div className={`gdrive-diff-line is-${line.kind}`} key={`${line.kind}:${index}`}>
        <span className="gdrive-diff-number">{line.oldLine ?? ""}</span><span className="gdrive-diff-number">{line.newLine ?? ""}</span>
        <span className="gdrive-diff-mark">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span><code>{line.text || " "}</code>
      </div>)}
  </div>;
}

function SplitDiff({ lines }: { lines: DiffLine[] }) {
  return <div className="gdrive-diff is-split" role="table" aria-label="Split local to Drive differences">
    {splitDiffRows(lines).map((row, index) => "gap" in row
      ? <div className="gdrive-diff-gap" key={`gap:${index}`}>⋯ {row.gap.text} ⋯</div>
      : <div className="gdrive-diff-split-row" key={`row:${index}`}>
        <SplitDiffCell line={row.left} side="local" />
        <SplitDiffCell line={row.right} side="drive" />
      </div>)}
  </div>;
}

function SplitDiffCell({ line, side }: { line: DiffLine | null; side: "local" | "drive" }) {
  return <div className={`gdrive-diff-split-cell is-${line?.kind ?? "empty"}`}>
    {line ? <React.Fragment><span className="gdrive-diff-number">{side === "local" ? line.oldLine ?? "" : line.newLine ?? ""}</span>
      <span className="gdrive-diff-mark">{line.kind === "removed" ? "−" : line.kind === "added" ? "+" : " "}</span><code>{line.text || " "}</code></React.Fragment> : <code> </code>}
  </div>;
}

function DriveDiffDialog({ api, path, close }: { api: PluginAPI; path: string; close: () => void }) {
  const [comparison, setComparison] = useState<ConflictPreview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void sharedClient(api).fileComparison(path).then((value) => {
      if (!cancelled) setComparison(value);
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { cancelled = true; };
  }, [api, path]);
  return <div className="gdrive-diff-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="gdrive-diff-dialog" role="dialog" aria-modal="true" aria-label={`Compare ${path} with Google Drive`}>
      <header><div><strong>Compare with Google Drive</strong><small>{path}</small></div><button type="button" className="secondary" onClick={close}>Close</button></header>
      <div className="gdrive-diff-dialog-body">
        {error ? <p className="danger">{error}</p> : comparison ? <DriveComparison value={comparison} /> : <p>Loading local and Drive versions…</p>}
      </div>
    </section>
  </div>;
}

export function openDriveDiffViewer(api: PluginAPI, path: string): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const close = () => { root.unmount(); container.remove(); };
  root.render(<DriveDiffDialog api={api} path={path} close={close} />);
}

export async function resetFileToDrive(api: PluginAPI, path: string): Promise<void> {
  if (!window.confirm(`Replace the local state of “${path}” with its current Google Drive state? Local-only files will be deleted.`)) return;
  const result = await sharedClient(api).resetFileToDrive(path);
  api.fileTree?.refreshDecorations();
  window.alert(result === "unchanged" ? "The file is already in the Google Drive state." : `Local file ${result} from Google Drive.`);
}

export function installDriveDiffActions(api: PluginAPI): () => void {
  const compareAction = {
    id: "compare-with-google-drive",
    label: "Compare with Google Drive",
    when: (target: { scope: "workspace" | "files"; isDirectory: boolean }) => target.scope === "workspace" && !target.isDirectory,
    onClick: (target: { path: string }) => openDriveDiffViewer(api, target.path),
  };
  const resetAction = {
    id: "reset-to-google-drive",
    label: "Reset to Google Drive state",
    when: (target: { scope: "workspace" | "files"; isDirectory: boolean }) => target.scope === "workspace" && !target.isDirectory,
    onClick: (target: { path: string }) => resetFileToDrive(api, target.path),
  };
  const disposers = [
    api.fileTree?.registerContextMenuItem?.(compareAction),
    api.fileViewer?.registerAction?.(compareAction),
    api.fileTree?.registerContextMenuItem?.(resetAction),
    api.fileViewer?.registerAction?.(resetAction),
  ].filter((dispose): dispose is () => void => typeof dispose === "function");
  return () => disposers.forEach((dispose) => dispose());
}
