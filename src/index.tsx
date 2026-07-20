import type { PluginAPI } from "./types";
import { DriveSyncSettings } from "./Settings";
import { DriveSyncView } from "./View";

export default class GemiHubGoogleDrivePlugin {
  onload(api: PluginAPI) {
    api.registerView({ id: "sync", name: "Drive Sync", icon: "cloud", location: "sidebar", component: DriveSyncView });
    api.registerSettingsTab?.({ component: DriveSyncSettings });
  }
}
