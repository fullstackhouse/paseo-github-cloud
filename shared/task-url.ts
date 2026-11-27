export const PROVIDER_ID = "github-cloud";
export const TASK_LABEL = "github-cloud.task";
export const OPEN_TASK_SCREEN_ID = "open-task";

export interface TaskLink {
  owner: string;
  repo: string;
  taskId: string;
}

/** `https://github.com/<owner>/<repo>/tasks/<uuid>`, with any trailing path, query or hash. */
export function parseTaskUrl(url: string): TaskLink | null {
  const match = url.match(
    /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i,
  );
  return match ? { owner: match[1], repo: match[2], taskId: match[3].toLowerCase() } : null;
}

/** Whether a git remote URL points at `owner/repo` on github.com. */
export function remoteMatches(remoteUrl: string | null | undefined, owner: string, repo: string): boolean {
  const match = remoteUrl?.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return !!match && match[1].toLowerCase() === owner.toLowerCase() && match[2].toLowerCase() === repo.toLowerCase();
}
