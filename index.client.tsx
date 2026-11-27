import type { PluginClientContext } from "@getpaseo/plugin/client";
import { OpenTaskScreen } from "./client/open-task-screen";
import { OPEN_TASK_SCREEN_ID, parseTaskUrl } from "./shared/task-url";

// COMPAT(link-handler-types): addLinkHandler ships in the FSH host build (fullstackhouse/paseo#266) but
// not yet in the published @getpaseo/plugin types. Remove once the npm types include it.
declare module "@getpaseo/plugin/client" {
  interface PluginClientContext {
    addLinkHandler(contribution: {
      id: string;
      title: string;
      icon?: string;
      match(url: string): boolean;
      open(context: {
        url: string;
        workspaceId: string | null;
        openScreen(input: { screenId: string; params?: Record<string, string> }): void;
      }): void | Promise<void>;
    }): () => void;
  }
}

export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({
    id: OPEN_TASK_SCREEN_ID,
    title: "GitHub cloud task",
    Component: OpenTaskScreen,
  });
  const removeLink = client.addLinkHandler({
    id: "task",
    title: "Open as Paseo agent",
    icon: "Cloud",
    match: (url) => parseTaskUrl(url) !== null,
    open({ url, workspaceId, openScreen }) {
      // The screen gets client navigation, which link handlers lack, to open the agent once it exists.
      openScreen({ screenId: OPEN_TASK_SCREEN_ID, params: { url, ...(workspaceId ? { workspaceId } : {}) } });
    },
  });
  return () => {
    removeLink();
    removeScreen();
  };
}
