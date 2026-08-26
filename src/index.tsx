import type { PluginAPI } from "./types";
import { DriveSyncSettings } from "./Settings";
import { DriveSyncView } from "./View";
import { installDriveDecorations } from "./decorations";

export default class GemiHubGoogleDrivePlugin {
  private disposeDecorations: (() => void) | null = null;
  onload(api: PluginAPI) {
    api.registerView({ id: "sync", name: "Drive Sync", icon: "cloud", location: "sidebar", component: DriveSyncView });
    api.registerSettingsTab?.({ component: DriveSyncSettings });
    this.disposeDecorations = installDriveDecorations(api);
  }
  onunload() { this.disposeDecorations?.(); this.disposeDecorations = null; }
}
