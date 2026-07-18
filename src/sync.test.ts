/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import { computeStatus, parallelForEach, planPush } from "./sync.ts";
import { isGoogleWorkspaceFile, reconcileSyncMeta, syncableDriveFile } from "./drive.ts";
import type { LocalSyncMeta, ProjectFile, SyncMeta } from "./types.ts";

const local = (path: string, md5: string): ProjectFile => ({ path, md5, size: 1, createdTime: 0, modTime: 0, binary: false });
const baseline = (md5 = "a"): LocalSyncMeta => ({ projectId: "p", lastUpdatedAt: "", files: { id: { name: "notes/a.md", md5Checksum: md5 } }, pathToId: { "notes/a.md": "id" } });
const remote = (md5 = "a"): SyncMeta => ({ lastUpdatedAt: "", files: { id: { name: "notes/a.md", md5Checksum: md5, mimeType: "text/markdown", modifiedTime: "" } } });

Deno.test("classifies local, remote, delete, and conflict changes", () => {
  assertEquals(computeStatus([local("notes/a.md", "b")], baseline(), remote()).localChanges, ["notes/a.md"]);
  assertEquals(computeStatus([local("notes/a.md", "a")], baseline(), remote("b")).remoteChanges, ["notes/a.md"]);
  assertEquals(computeStatus([local("notes/a.md", "b")], baseline(), remote("c")).conflicts, ["notes/a.md"]);
  assertEquals(computeStatus([], baseline(), remote()).localDeletes, ["notes/a.md"]);
  assertEquals(computeStatus([local("notes/a.md", "a")], baseline(), { lastUpdatedAt: "", files: {} }).remoteDeletes, ["notes/a.md"]);
});

Deno.test("classifies a checksum-preserving local rename without a delete", () => {
  const status = computeStatus([local("notes/renamed.md", "a")], baseline(), remote());
  assertEquals(status.localChanges, ["notes/renamed.md"]);
  assertEquals(status.localDeletes, []);
});

Deno.test("does not mistake a duplicate-content file for a deleted file rename", () => {
  const sameContentBaseline: LocalSyncMeta = {
    projectId: "p", lastUpdatedAt: "",
    files: { a: { name: "a.md", md5Checksum: "same" }, b: { name: "b.md", md5Checksum: "same" } },
    pathToId: { "a.md": "a", "b.md": "b" },
  };
  const sameContentRemote: SyncMeta = {
    lastUpdatedAt: "",
    files: {
      a: { name: "a.md", md5Checksum: "same", mimeType: "text/markdown", modifiedTime: "" },
      b: { name: "b.md", md5Checksum: "same", mimeType: "text/markdown", modifiedTime: "" },
    },
  };
  const status = computeStatus([local("b.md", "same")], sameContentBaseline, sameContentRemote);
  assertEquals(status.localDeletes, ["a.md"]);
  assertEquals(status.localChanges, []);
});

Deno.test("treats rename-delete races as conflicts", () => {
  const localRenameRemoteDelete = computeStatus([local("renamed.md", "a")], baseline(), { lastUpdatedAt: "", files: {} });
  assertEquals(localRenameRemoteDelete.conflicts, ["renamed.md"]);

  const localDeleteRemoteRename = computeStatus([], baseline(), {
    lastUpdatedAt: "",
    files: { id: { name: "notes/renamed.md", md5Checksum: "a", mimeType: "text/markdown", modifiedTime: "" } },
  });
  assertEquals(localDeleteRemoteRename.conflicts, ["notes/a.md"]);
});

Deno.test("recognizes already-applied remote state after an interrupted pull", () => {
  const currentRemote: SyncMeta = {
    lastUpdatedAt: "",
    files: { id: { name: "notes/a.md", md5Checksum: "current", mimeType: "text/markdown", modifiedTime: "" } },
  };
  const status = computeStatus([local("notes/a.md", "current")], baseline("old"), currentRemote);
  assertEquals(status.conflicts, []);
  assertEquals(status.localChanges, []);
  assertEquals(status.remoteChanges, []);
});

Deno.test("push adopts identical untracked files without re-upload or rename", () => {
  const empty: LocalSyncMeta = { projectId: "p", lastUpdatedAt: "", files: {}, pathToId: {} };
  assertEquals(planPush([local("notes/a.md", "a")], empty, remote()), [
    { local: local("notes/a.md", "a"), id: "id", rename: false, upload: null },
  ]);
});

Deno.test("push plans renames, updates, creates, and skips from the tracked baseline", () => {
  assertEquals(planPush([local("notes/renamed.md", "a")], baseline(), remote()), [
    { local: local("notes/renamed.md", "a"), id: "id", rename: true, upload: null },
  ]);
  assertEquals(planPush([local("notes/a.md", "b")], baseline(), remote()), [
    { local: local("notes/a.md", "b"), id: "id", rename: false, upload: "update" },
  ]);
  assertEquals(planPush([local("new.md", "x")], baseline("other"), remote("other")), [
    { local: local("new.md", "x"), id: undefined, rename: false, upload: "create" },
  ]);
  assertEquals(planPush([local("notes/a.md", "a")], baseline(), remote()), [
    { local: local("notes/a.md", "a"), id: "id", rename: false, upload: null },
  ]);
});

Deno.test("excludes Google Workspace native files but keeps exported binary files", () => {
  assertEquals(isGoogleWorkspaceFile({ mimeType: "application/vnd.google-apps.presentation" }), true);
  assertEquals(syncableDriveFile({ name: "Planning", mimeType: "application/vnd.google-apps.document" }), false);
  assertEquals(syncableDriveFile({ name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" }), false);
  assertEquals(syncableDriveFile({ name: "Planning.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), true);
});

Deno.test("reconciles stale sync metadata against the live Drive listing", () => {
  const stale: SyncMeta = {
    lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    files: {
      deleted: { name: "deleted.md", mimeType: "text/markdown", md5Checksum: "old", modifiedTime: "old" },
      kept: { name: "kept.md", mimeType: "text/markdown", md5Checksum: "stale", modifiedTime: "stale", size: "12" },
    },
  };
  const reconciled = reconcileSyncMeta(stale, [
    { id: "kept", name: "kept.md", mimeType: "text/markdown", md5Checksum: "current", modifiedTime: "current" },
    { id: "created", name: "created.md", mimeType: "text/markdown", md5Checksum: "new", modifiedTime: "new" },
  ]);

  assertEquals(Object.keys(reconciled.files).sort(), ["created", "kept"]);
  assertEquals(reconciled.files.kept.md5Checksum, "current");
  assertEquals(reconciled.files.kept.size, "12");
});

Deno.test("pull worker pool limits concurrency", async () => {
  let active = 0, maximum = 0, completed = 0;
  await parallelForEach(Array.from({ length: 17 }, (_, index) => index), async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--; completed++;
  }, 5);
  assertEquals(maximum, 5);
  assertEquals(completed, 17);
});
