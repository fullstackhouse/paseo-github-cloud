import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { PendingRequest } from "./timeline";

/**
 * What a reopened agent replays. Paseo rebuilds an agent's timeline from the provider's replay when it
 * reloads one, and fetching a long task's events takes minutes (GitHub answers each request in ~8 s),
 * so the timeline the agent already showed is kept on disk and only newer events are fetched.
 */
export interface TaskSnapshot {
  /** The last event already shown. */
  cursor: string | null;
  /** Requests the agent still waits on. */
  pending: PendingRequest[];
  /** Every timeline item shown, latest version of each, in order. */
  items: ProviderTimelineItem[];
}

export interface TaskCache {
  load(taskId: string): Promise<TaskSnapshot | null>;
  save(taskId: string, snapshot: TaskSnapshot): Promise<void>;
}

/** One JSON file per task under the plugin's data directory. */
export function fileTaskCache(dir = defaultDir()): TaskCache {
  const file = (taskId: string) => join(dir, `${taskId.replace(/[^a-z0-9-]/gi, "")}.json`);
  return {
    async load(taskId) {
      try {
        return JSON.parse(await readFile(file(taskId), "utf8")) as TaskSnapshot;
      } catch {
        return null;
      }
    },
    async save(taskId, snapshot) {
      await mkdir(dir, { recursive: true });
      const target = file(taskId);
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(temp, target);
    },
  };
}

function defaultDir(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-github-cloud", "tasks");
}
