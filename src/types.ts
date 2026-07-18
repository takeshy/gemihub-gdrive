import type React from "react";

export interface Project { id: string; name: string; path: string }
export interface ProjectFile { path: string; size: number; createdTime: number; modTime: number; md5: string; binary: boolean }
export interface HTTPRequest { url: string; method?: string; headers?: Record<string, string>; body?: string; bodyBase64?: string }
export interface HTTPResponse { status: number; headers: Record<string, string>; body: string; bodyBase64: string }

export interface PluginAPI {
  language: string;
  registerView(view: { id: string; name: string; icon?: string; location: "sidebar" | "main"; component: React.ComponentType<{ api: PluginAPI }> }): void;
  projectFiles?: {
    current(): Promise<Project | null>;
    inventory(): Promise<ProjectFile[]>;
    read(path: string): Promise<string>;
    create(path: string, content: string | ArrayBuffer): Promise<void>;
    update(path: string, content: string | ArrayBuffer): Promise<void>;
    createDirectory(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    delete(path: string): Promise<void>;
  };
  storage?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; getAll(): Promise<Record<string, unknown>> };
  network?: { request(request: HTTPRequest): Promise<HTTPResponse> };
}

export interface FileSyncMeta {
  name: string;
  mimeType: string;
  md5Checksum: string;
  modifiedTime: string;
  createdTime?: string;
  size?: string;
}

export interface SyncMeta { lastUpdatedAt: string; files: Record<string, FileSyncMeta> }
export interface LocalSyncMeta {
  projectId: string;
  lastUpdatedAt: string;
  files: Record<string, { name: string; md5Checksum: string }>;
  pathToId: Record<string, string>;
}

export interface SyncStatus {
  localChanges: string[];
  remoteChanges: string[];
  localOnly: string[];
  remoteOnly: string[];
  localDeletes: string[];
  remoteDeletes: string[];
  conflicts: string[];
}

export interface SyncSummary { created: number; updated: number; renamed: number; deleted: number; skipped: number }
