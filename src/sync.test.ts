/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import { computeStatus, parallelForEach } from "./sync.ts";
import { isGoogleWorkspaceFile, syncableDriveFile } from "./drive.ts";
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

Deno.test("excludes Google Workspace native files but keeps exported binary files", () => {
  assertEquals(isGoogleWorkspaceFile({ mimeType: "application/vnd.google-apps.presentation" }), true);
  assertEquals(syncableDriveFile({ name: "Planning", mimeType: "application/vnd.google-apps.document" }), false);
  assertEquals(syncableDriveFile({ name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" }), false);
  assertEquals(syncableDriveFile({ name: "Planning.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), true);
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
