import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Client for GitHub's Copilot cloud agent ("Mission Control") task API. The API is private and
 * undocumented; VS Code's `src/vs/platform/github/common/missionControl/tasksClient.ts` is the
 * reference for its shape.
 */

export type TaskState =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "idle"
  | "waiting_for_user"
  | "timed_out"
  | "cancelled";

export interface TaskRepository {
  id?: number;
  name: string;
  full_name?: string;
  owner?: { login?: string };
}

export interface TaskSession {
  id: string;
  state: TaskState;
  model?: string;
  error?: { message?: string } | null;
}

export interface Task {
  id: string;
  name?: string;
  html_url?: string;
  state: TaskState;
  remote_steerable: boolean;
  repository?: TaskRepository;
  repositories?: TaskRepository[];
  sessions?: TaskSession[];
  artifacts?: Array<{ type?: string; data?: { url?: string; html_url?: string; number?: number } }>;
}

export interface TaskEvent {
  id: string;
  timestamp: string;
  parentId: string | null;
  type: string;
  data: Record<string, unknown>;
  ephemeral?: boolean;
  pending?: boolean;
  dismissed?: boolean;
  /** Set on a sub-agent's events: the parent task tool call. */
  agentId?: string;
}

export type SteerRequest =
  | { type: "abort" }
  | {
      type?:
        | "user_message"
        | "ask_user_response"
        | "plan_approval_response"
        | "permission_response"
        | "elicitation_response"
        | "mode_switch";
      content: string;
      model?: string;
      reasoning_effort?: string;
      event_identifiers?: string[];
    };

export interface CreateTaskRequest {
  prompt: string;
  repositories: Array<{ owner: string; name: string }>;
  agent_id?: number;
  model?: string;
  base_ref?: string;
}

/** Task states in which the agent is not working and waits for the user. */
export const RESTING_STATES: ReadonlySet<TaskState> = new Set([
  "completed",
  "failed",
  "idle",
  "waiting_for_user",
  "timed_out",
  "cancelled",
]);

export class CopilotTasksApi {
  private constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  /** Uses GH_TOKEN/GITHUB_TOKEN, else the gh CLI login, and asks GitHub which Copilot host serves the user. */
  static async connect(env: Readonly<Record<string, string | undefined>>): Promise<CopilotTasksApi> {
    const token = await readToken(env);
    const host = await discoverApiHost(token);
    return new CopilotTasksApi(`${host}/agents`, token);
  }

  /** Models the cloud agent offers this user, minus ones the picker hides or policy disables. */
  async models(): Promise<Array<{ id: string; name: string }>> {
    const body = await this.request<{
      data: Array<{ id: string; name?: string; model_picker_enabled?: boolean; policy?: { state?: string } }>;
    }>("GET", "/swe/models");
    return body.data
      .filter((model) => model.model_picker_enabled !== false && model.policy?.state !== "disabled")
      .map((model) => ({ id: model.id, name: model.name ?? model.id }));
  }

  getTask(taskId: string): Promise<Task> {
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}`);
  }

  createTask(request: CreateTaskRequest): Promise<Task> {
    return this.request("POST", "/tasks", request);
  }

  async steer(taskId: string, request: SteerRequest): Promise<void> {
    await this.request("POST", `/tasks/${encodeURIComponent(taskId)}/steer`, request);
  }

  /** One page of events after `after` (oldest first) and the cursor for the next page, if any. */
  async events(taskId: string, after: string | null): Promise<{ events: TaskEvent[]; next: string | null }> {
    const query = new URLSearchParams({ per_page: "100" });
    if (after) query.set("after", after);
    const response = await this.fetch("GET", `/tasks/${encodeURIComponent(taskId)}/events?${query}`);
    const body = (await response.json()) as { events: TaskEvent[] };
    return { events: body.events, next: nextCursor(response.headers.get("link")) };
  }

  /** Every event after `after`, following pagination. */
  async allEvents(taskId: string, after: string | null): Promise<TaskEvent[]> {
    const events: TaskEvent[] = [];
    let cursor = after;
    for (;;) {
      const page = await this.events(taskId, cursor);
      events.push(...page.events);
      if (!page.next || page.events.length === 0) return events;
      cursor = page.next;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetch(method, path, body);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async fetch(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${method} ${path.split("?")[0]} failed (${response.status}): ${errorText(text)}`);
    }
    return response;
  }
}

/** The `after` cursor from a `Link: <...?after=X>; rel="next"` header. */
export function nextCursor(link: string | null): string | null {
  const match = link?.match(/<([^>]+)>;\s*rel="next"/);
  if (!match) return null;
  return new URL(match[1], "https://api.invalid").searchParams.get("after");
}

async function readToken(env: Readonly<Record<string, string | undefined>>): Promise<string> {
  const fromEnv = env.GH_TOKEN || env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { env: { ...process.env, ...env } });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // fall through to the error below
  }
  throw new Error("Needs a GitHub login: run `gh auth login`, or set GH_TOKEN in the daemon environment.");
}

async function discoverApiHost(token: string): Promise<string> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ viewer { copilotEndpoints { api } } }" }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: { viewer?: { copilotEndpoints?: { api?: string } } };
  } | null;
  return body?.data?.viewer?.copilotEndpoints?.api ?? "https://api.individual.githubcopilot.com";
}

function errorText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (parsed.message) return parsed.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 300) || "no response body";
}
