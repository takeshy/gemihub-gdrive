import { WorkspaceDriveSync } from "./sync";
import type { PluginAPI } from "./types";

const clients = new WeakMap<PluginAPI, WorkspaceDriveSync>();

export function sharedClient(api: PluginAPI): WorkspaceDriveSync {
  const existing = clients.get(api);
  if (existing) return existing;
  const client = new WorkspaceDriveSync(api);
  clients.set(api, client);
  return client;
}
