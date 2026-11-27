import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { usePaseo, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { taskInfo } from "../shared/rpc";
import { PROVIDER_ID, TASK_LABEL, parseTaskUrl, remoteMatches } from "../shared/task-url";

type PaseoApi = ReturnType<typeof usePaseo>;
type Workspace = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];

/**
 * Opens a GitHub cloud task as a Paseo agent: reuses the agent already following the task, or
 * creates one in a workspace on the task's repository, then navigates to it.
 */
export function OpenTaskScreen({ params, navigation, theme }: PluginScreenProps) {
  const paseo = usePaseo();
  const readTask = useRpc(taskInfo);
  const [message, setMessage] = useState("Opening the task…");
  const [failed, setFailed] = useState(false);
  const url = params.url ?? "";

  useEffect(() => {
    let cancelled = false;
    openTask(paseo, readTask, url, params.workspaceId ?? null)
      .then((agentId) => {
        if (!cancelled) navigation?.openAgent({ agentId });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailed(true);
        setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, readTask, url, params.workspaceId, navigation]);

  return (
    <View style={{ flex: 1, padding: 24, gap: 8, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: failed ? theme.colors.statusDanger : theme.colors.foreground }}>{message}</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>{url}</Text>
    </View>
  );
}

async function openTask(
  paseo: PaseoApi,
  readTask: (input: { taskId: string }) => Promise<{ name: string | null }>,
  url: string,
  activeWorkspaceId: string | null,
): Promise<string> {
  const link = parseTaskUrl(url);
  if (!link) throw new Error("This is not a GitHub cloud task link.");

  const existing = await paseo.agents.list({ filter: { labels: { [TASK_LABEL]: link.taskId } } });
  const agent = existing.entries[0]?.agent;
  if (agent) return agent.id;

  const { entries } = await paseo.workspaces.list();
  const workspace = pickWorkspace(entries, link.owner, link.repo, activeWorkspaceId);
  if (!workspace) {
    throw new Error(`No workspace in Paseo is a checkout of ${link.owner}/${link.repo}. Add the repository as a project, then open the link again.`);
  }
  const { name } = await readTask({ taskId: link.taskId }).catch(() => ({ name: null }));
  const created = await paseo.workspaces.ref(workspace).agents.create({
    title: name ?? `GitHub task ${link.taskId.slice(0, 8)}`,
    config: { provider: `${PROVIDER_ID}/auto`, options: { taskId: link.taskId } },
    labels: { [TASK_LABEL]: link.taskId },
  });
  return created.id;
}

/** The active workspace when it is on the task's repository, else the main checkout, else any match. */
function pickWorkspace(
  workspaces: readonly Workspace[],
  owner: string,
  repo: string,
  activeWorkspaceId: string | null,
): Workspace | undefined {
  const matching = workspaces.filter((workspace) => remoteMatches(workspace.gitRuntime?.remoteUrl, owner, repo));
  return (
    matching.find((workspace) => workspace.id === activeWorkspaceId) ??
    matching.find((workspace) => workspace.workspaceKind === "local_checkout") ??
    matching[0]
  );
}
