/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import { metaFromFiles, writeSyncMeta, type DriveFile } from "./drive.ts";
import type { HTTPRequest, HTTPResponse, PluginAPI, SyncMeta } from "./types.ts";

const rootFiles: DriveFile[] = [
  { id: "doc1", name: "notes/a.md", mimeType: "text/markdown", md5Checksum: "m1", modifiedTime: "t1", createdTime: "c1", size: "3" },
];

const existingMeta: SyncMeta = {
  lastUpdatedAt: "2026-01-01T00:00:00.000Z",
  files: {
    doc1: { name: "notes/a.md", mimeType: "text/markdown", md5Checksum: "m0", modifiedTime: "t0", shared: true, webViewLink: "https://drive.google.com/x" },
    gdoc: { name: "Planning", mimeType: "application/vnd.google-apps.document", md5Checksum: "", modifiedTime: "t0" },
  },
};

function driveMock(): { api: PluginAPI; writes: string[] } {
  const writes: string[] = [];
  const ok = (body: string): HTTPResponse => ({ status: 200, headers: {}, body, bodyBase64: "" });
  const api: PluginAPI = {
    language: "en",
    registerView() {},
    network: {
      async request(request: HTTPRequest): Promise<HTTPResponse> {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/upload/")) {
          writes.push(request.body ?? "");
          return ok(JSON.stringify({ id: "meta" }));
        }
        if (url.pathname.endsWith("/files/meta") && url.searchParams.get("alt") === "media") return ok(JSON.stringify(existingMeta));
        if ((url.searchParams.get("q") ?? "").includes("_sync-meta.json")) {
          return ok(JSON.stringify({ files: [{ id: "meta", name: "_sync-meta.json", mimeType: "application/json", modifiedTime: "t0" }] }));
        }
        return ok(JSON.stringify({ files: rootFiles }));
      },
    },
  };
  return { api, writes };
}

Deno.test("writeSyncMeta keeps sharing state and Google Workspace entries", async () => {
  const { api, writes } = driveMock();
  await writeSyncMeta(api, "token", "root", metaFromFiles(rootFiles));

  assertEquals(writes.length, 1);
  const written = JSON.parse(writes[0]) as SyncMeta;
  assertEquals(written.files.doc1.md5Checksum, "m1");
  assertEquals(written.files.doc1.shared, true);
  assertEquals(written.files.doc1.webViewLink, "https://drive.google.com/x");
  assertEquals(written.files.gdoc.name, "Planning");
});
