import type {
  ProviderConfigChanges,
  ProviderConfigState,
  ProviderEvent,
  ProviderMode,
  ProviderModel,
  ProviderPermissionResponse,
  ProviderPrompt,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { RESTING_STATES, type CopilotTasksApi, type SteerRequest, type Task, type TaskState } from "./api";
import type { GitHubRepo } from "./repo";
import { TimelineMapper, type PendingRequest } from "./timeline";

export const DEFAULT_MODEL = "auto";
export const DEFAULT_MODE = "default";

/** Fallback catalogue; the provider replaces it with `/agents/swe/models` when that answers. */
export const MODELS: ProviderModel[] = [{ id: "auto", label: "Auto", isDefault: true }];

/** The coding agent has no modes. Interactive tasks (started on github.com) report theirs. */
export const MODES: ProviderMode[] = [{ id: DEFAULT_MODE, label: "Default" }];
const INTERACTIVE_MODES: ProviderMode[] = [
  { id: "interactive", label: "Interactive" },
  { id: "plan", label: "Plan" },
  { id: "autopilot", label: "Autopilot" },
];

const ACTIVE_POLL_MS = 2_000;
const RESTING_POLL_MS = 10_000;
/** How long a new prompt may leave the task resting before we stop waiting for it to start. */
const START_GRACE_MS = 90_000;

export function configState(model: string, mode: string, models: ProviderModel[] = MODELS): ProviderConfigState {
  const modes = mode === DEFAULT_MODE ? MODES : INTERACTIVE_MODES;
  return { model, mode, models, modes, thinkingOptions: [] };
}

interface Turn {
  id: string;
  startedAt: number;
  sawBusy: boolean;
  interruptRequested: boolean;
}

interface Options {
  api: CopilotTasksApi;
  paseoSessionId: string;
  task: Task | null;
  repo: GitHubRepo | null;
  model: string;
  mode: string;
  models?: ProviderModel[];
  emit: (event: ProviderEvent) => void;
  log: (message: string) => void;
}

/**
 * One Paseo agent following one GitHub cloud agent task. Paseo prompts become the task's first
 * prompt or steer messages; task events become timeline items through a 2 s poll while the agent
 * works and a slower one while it rests, so work started on github.com shows up too.
 */
export class CloudTaskSession {
  private readonly api: CopilotTasksApi;
  private readonly sessionId: string;
  private readonly repo: GitHubRepo | null;
  private readonly emit: (event: ProviderEvent) => void;
  private readonly log: (message: string) => void;
  private readonly mapper = new TimelineMapper();
  private readonly pending = new Map<string, PendingRequest>();
  /** Prompts Paseo already drew; their echoes from the task are skipped. */
  private readonly echoes: string[] = [];
  private readonly models: ProviderModel[];
  private task: Task | null;
  private model: string;
  private mode: string;
  private cursor: string | null = null;
  private turn: Turn | null = null;
  private turnCounter = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: Options) {
    this.api = options.api;
    this.sessionId = options.paseoSessionId;
    this.task = options.task;
    this.repo = options.repo;
    this.model = options.model;
    this.mode = options.mode;
    this.models = options.models ?? MODELS;
    this.emit = options.emit;
    this.log = options.log;
  }

  /**
   * Reads the task's history (rendering it when `replay`), raises requests it still waits on, then
   * follows it. `catchUp` leaves the whole history to the first poll, which emits it as live events.
   */
  async attach(options: { replay: boolean } | { catchUp: true }): Promise<void> {
    if (!this.task) return;
    if ("catchUp" in options) {
      this.schedule(ACTIVE_POLL_MS);
      return;
    }
    const { replay } = options;
    const events = await this.api.allEvents(this.task.id, null);
    for (const event of events) {
      const mapped = this.mapper.map(event);
      if (replay) for (const item of mapped.items) this.emitItem(item);
      this.track(mapped.request, mapped.resolves, mapped.mode);
    }
    if (replay) for (const item of this.mapper.closeOpenTools("completed")) this.emitItem(item);
    this.cursor = events.at(-1)?.id ?? null;
    for (const request of this.pending.values()) this.raise(request);
    if (!RESTING_STATES.has(this.task.state)) this.beginTurn(true);
    this.schedule(0);
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (prompt.input.type !== "message") {
      this.promptResult(prompt, { type: "failed", error: { message: "Commands are not supported by cloud tasks" } });
      return;
    }
    const text = prompt.input.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
    if (!text) {
      this.promptResult(prompt, { type: "failed", error: { message: "Cloud tasks take text prompts only" } });
      return;
    }
    try {
      const question = [...this.pending.values()].find((request) => request.kind === "question");
      if (!this.task) await this.createTask(text);
      else if (question) await this.answerQuestion(question, text);
      else await this.steer({ type: "user_message", content: text, ...this.modelField() });
    } catch (error) {
      this.promptResult(prompt, { type: "failed", error: { message: errorMessage(error) } });
      return;
    }
    this.echoes.push(text);
    this.emitItem({ type: "user_message", id: `user:${prompt.clientMessageId}`, text, clientMessageId: prompt.clientMessageId });
    if (this.turn) {
      this.promptResult(prompt, { type: "steer", turnId: this.turn.id });
      return;
    }
    const turn = this.beginTurn(false);
    this.promptResult(prompt, { type: "turn", turnId: turn.id });
    this.schedule(ACTIVE_POLL_MS);
  }

  async interrupt(): Promise<void> {
    if (!this.task) return;
    if (this.turn) this.turn.interruptRequested = true;
    await this.steer({ type: "abort" });
    this.schedule(ACTIVE_POLL_MS);
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (changes.model !== undefined) this.model = changes.model ?? DEFAULT_MODEL;
    if (changes.mode && changes.mode !== this.mode) {
      if (this.mode === DEFAULT_MODE) throw new Error("This task's agent has no modes");
      if (this.task) await this.steer({ type: "mode_switch", content: JSON.stringify({ mode: changes.mode }) });
      this.mode = changes.mode;
    }
    this.publishConfig();
  }

  async respondToPermission(permissionId: string, response: ProviderPermissionResponse): Promise<void> {
    const request = this.pending.get(permissionId);
    if (!request) return;
    const allow = response.behavior === "allow";
    try {
      await this.answer(request, response, allow);
    } catch (error) {
      this.emitItem({ type: "error", id: `answer:${permissionId}:${Date.now()}`, message: errorMessage(error) });
      return;
    }
    this.resolve(permissionId);
    this.schedule(ACTIVE_POLL_MS);
  }

  private async answer(request: PendingRequest, response: ProviderPermissionResponse, allow: boolean): Promise<void> {
    switch (request.kind) {
      case "plan": {
        const action = allow ? response.selectedActionId?.replace(/^plan:/, "") : undefined;
        await this.steer({
          type: "plan_approval_response",
          content: JSON.stringify({
            approved: allow,
            ...(action ? { selectedAction: action } : {}),
            ...(response.behavior === "deny" && response.message ? { feedback: response.message } : {}),
          }),
          event_identifiers: [allow ? "plan_approved" : "plan_dismissed"],
        });
        break;
      }
      case "question": {
        const answer = allow ? response.selectedActionId?.replace(/^choice:/, "") : undefined;
        await this.answerQuestion(request, answer ?? null);
        break;
      }
      case "permission":
        await this.steer({
          type: "permission_response",
          content: JSON.stringify({ promptId: request.toolCallId ?? request.requestId, approved: allow }),
        });
        break;
    }
  }

  /** Stops following the task. The task keeps running on GitHub. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async createTask(prompt: string): Promise<void> {
    if (!this.repo) throw new Error("No repository to start the task on");
    this.task = await this.api.createTask({
      prompt,
      repositories: [{ owner: this.repo.owner, name: this.repo.name }],
      ...this.modelField(),
    });
    this.emit({ type: "session.persistence", sessionId: this.sessionId, persistence: { version: 1, data: { taskId: this.task.id } } });
  }

  private async answerQuestion(question: PendingRequest, answer: string | null): Promise<void> {
    await this.steer({
      type: "ask_user_response",
      content: JSON.stringify(
        answer === null
          ? { requestId: question.requestId, skipped: true }
          : {
              requestId: question.requestId,
              answer,
              wasFreeform: !(question.choices ?? []).includes(answer),
            },
      ),
    });
    this.resolve(question.requestId);
  }

  private modelField(): { model?: string } {
    return this.model && this.model !== "auto" ? { model: this.model } : {};
  }

  private async steer(request: SteerRequest): Promise<void> {
    if (!this.task) throw new Error("The task has not started yet");
    try {
      await this.api.steer(this.task.id, request);
    } catch (error) {
      // Interactive sandbox tasks (started on github.com) take input over GitHub's relay protocol, not
      // this API, and refuse it here once the sandbox idles.
      if (/not steerable/i.test(errorMessage(error))) {
        throw new Error(`GitHub doesn't accept input for this task from Paseo while it's idle. Reply on github.com: ${taskUrl(this.task)}`);
      }
      throw error;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.task) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll()
        .catch((error) => this.log(`poll failed: ${errorMessage(error)}`))
        .finally(() => this.schedule(this.turn ? ACTIVE_POLL_MS : RESTING_POLL_MS));
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (!this.task || this.stopped) return;
    const [task, events] = await Promise.all([
      this.api.getTask(this.task.id),
      this.api.allEvents(this.task.id, this.cursor),
    ]);
    if (this.stopped) return;
    this.task = task;
    for (const event of events) {
      const mapped = this.mapper.map(event);
      for (const item of mapped.items) {
        if (item.type === "user_message" && this.consumeEcho(item.text)) continue;
        this.emitItem(item);
      }
      const raised = this.track(mapped.request, mapped.resolves, mapped.mode);
      if (raised) this.raise(raised);
    }
    if (events.length > 0) this.cursor = events.at(-1)!.id;
    this.advanceTurn(task.state);
  }

  /** Tracks requests the agent waits on. Returns a new request to raise, if any. */
  private track(request: PendingRequest | undefined, resolves: string | undefined, mode: string | undefined) {
    if (mode && mode !== this.mode) {
      this.mode = mode;
      this.publishConfig();
    }
    if (resolves && this.pending.has(resolves)) this.resolve(resolves);
    if (!request || this.pending.has(request.requestId)) return undefined;
    this.pending.set(request.requestId, request);
    return request;
  }

  private raise(request: PendingRequest): void {
    this.emit({
      type: "session.permission",
      sessionId: this.sessionId,
      request:
        request.kind === "plan"
          ? {
              id: request.requestId,
              name: "Plan",
              kind: "plan",
              title: request.title,
              actions: [
                ...(request.actions ?? ["interactive"])
                  .filter((action) => action !== "exit_only")
                  .map((action, index) => ({
                    id: `plan:${action}`,
                    label: `Approve (${action})`,
                    behavior: "allow" as const,
                    variant: index === 0 ? ("primary" as const) : ("secondary" as const),
                  })),
                { id: "reject", label: "Keep planning", behavior: "deny" as const },
              ],
            }
          : request.kind === "question"
            ? {
                id: request.requestId,
                name: "Question",
                kind: "question",
                title: request.title,
                description: "Pick an answer, or type a reply in the composer.",
                actions: [
                  ...(request.choices ?? []).map((choice, index) => ({
                    id: `choice:${choice}`,
                    label: choice,
                    behavior: "allow" as const,
                    variant: index === 0 ? ("primary" as const) : ("secondary" as const),
                  })),
                  { id: "skip", label: "Skip", behavior: "deny" as const },
                ],
              }
            : { id: request.requestId, name: "Permission", kind: "tool", title: request.title },
    });
  }

  private resolve(requestId: string): void {
    if (!this.pending.delete(requestId)) return;
    this.emit({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId: requestId });
  }

  private beginTurn(sawBusy: boolean): Turn {
    const turn: Turn = { id: `turn-${++this.turnCounter}-${Date.now()}`, startedAt: Date.now(), sawBusy, interruptRequested: false };
    this.turn = turn;
    this.emit({ type: "session.turn", sessionId: this.sessionId, turnId: turn.id, state: "started" });
    return turn;
  }

  /** Opens a turn for work started elsewhere (github.com) and closes the turn once the task rests. */
  private advanceTurn(state: TaskState): void {
    const resting = RESTING_STATES.has(state);
    if (!this.turn) {
      if (!resting) this.beginTurn(true);
      return;
    }
    if (!resting) {
      this.turn.sawBusy = true;
      return;
    }
    // A prompt we just sent may not have moved the task out of its resting state yet.
    if (!this.turn.sawBusy && Date.now() - this.turn.startedAt < START_GRACE_MS) return;
    this.finishTurn(state);
  }

  private finishTurn(state: TaskState): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    const canceled = state === "cancelled" || turn.interruptRequested;
    for (const item of this.mapper.closeOpenTools(canceled ? "canceled" : "completed")) this.emitItem(item);
    const failure = state === "failed" || state === "timed_out" ? lastSessionError(this.task) : null;
    this.emit({
      type: "session.turn",
      sessionId: this.sessionId,
      turnId: turn.id,
      ...(canceled
        ? { state: "canceled" as const }
        : failure !== null
          ? { state: "failed" as const, error: { message: failure } }
          : { state: "completed" as const }),
    });
  }

  private consumeEcho(text: string): boolean {
    const index = this.echoes.findIndex((echo) => echo.trim() === text.trim());
    if (index === -1) return false;
    this.echoes.splice(index, 1);
    return true;
  }

  private publishConfig(): void {
    this.emit({ type: "session.config", sessionId: this.sessionId, config: configState(this.model, this.mode, this.models) });
  }

  private promptResult(
    prompt: ProviderPrompt,
    result: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"],
  ): void {
    this.emit({ type: "session.prompt_result", sessionId: this.sessionId, clientMessageId: prompt.clientMessageId, result });
  }

  private emitItem(item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
  }
}

function taskUrl(task: Task): string {
  const repo = task.repository?.full_name ?? task.repositories?.[0]?.full_name;
  return task.html_url ?? (repo ? `https://github.com/${repo}/tasks/${task.id}` : `https://github.com/copilot/agents`);
}

function lastSessionError(task: Task | null): string {
  const session = task?.sessions?.at(-1);
  return session?.error?.message || `The task ${task?.state ?? "failed"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
