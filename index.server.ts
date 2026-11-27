import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CopilotTasksApi } from "./server/api";
import { createGitHubCloudProvider } from "./server/provider";
import { taskInfo } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createGitHubCloudProvider({ log: (message) => console.error(`[github-cloud] ${message}`) }));
  server.handle(taskInfo, async ({ taskId }) => {
    const task = await (await CopilotTasksApi.connect({})).getTask(taskId);
    return { name: task.name ?? null };
  });
  return () => {};
}
