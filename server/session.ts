import { randomUUID } from "node:crypto";
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
import { RESTING_STATES, type CopilotTasksApi, type Task, type TaskState } from "./api";
import { isSandboxTask, taskInput, type TaskInput } from "./input";
import type { TaskCache } from "./cache";
import type { GitHubRepo } from "./repo";
import { TimelineMapper, type PendingRequest } from "./timeline";

export const DEFAULT_MODEL = "auto";

/** Interactive sandbox modes, as on github.com, plus the pull-request coding agent. */
export const PULL_REQUEST_MODE = "pull-request";
export const DEFAULT_MODE = "interactive";
const SANDBOX_MODES: ProviderMode[] = [
  { id: "interactive", label: "Interactive", description: "Chat with the agent in a cloud sandbox" },
  { id: "plan", label: "Plan", description: "The agent plans first and asks you to approve" },
  { id: "autopilot", label: "Autopilot", description: "The agent works through the task on its own" },
];
const PULL_REQUEST: ProviderMode = {
  id: PULL_REQUEST_MODE,
  label: "Pull request agent",
  description: "GitHub's coding agent works on a branch and opens a pull request",
};
/** Modes a new agent can start in; the mode decides which kind of task its first message starts. */
export const MODES: ProviderMode[] = [...SANDBOX_MODES, PULL_REQUEST];

/** Fallback catalogue; the provider replaces it with `/agents/swe/models` when that answers. */
export const MODELS: ProviderModel[] = [{ id: "auto", label: "Auto", isDefault: true }];

const ACTIVE_POLL_MS = 2_000;
const QUESTION_HEADER = "Answer";
/** How long sandbox input may take before Paseo says the sandbox is waking. */
const WAKE_NOTICE_MS = 5_000;
const RESTING_POLL_MS = 10_000;
/** How long a new prompt may leave the task resting before we stop waiting for it to start. */
const START_GRACE_MS = 90_000;

export type TaskKind = "new" | "sandbox" | "pull-request";

export function taskKind(task: Task | null): TaskKind {
  if (!task) return "new";
  return isSandboxTask(task) ? "sandbox" : "pull-request";
}

export function configState(model: string, mode: string, models: ProviderModel[], kind: TaskKind): ProviderConfigState {
  const modes = kind === "new" ? MODES : kind === "sandbox" ? SANDBOX_MODES : [PULL_REQUEST];
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
  cache: TaskCache;
  /** How input reaches the task; injected in tests. */
  inputFor?: (task: Task) => TaskInput;
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
  private readonly cache: TaskCache;
  /** Every timeline item shown, latest version of each, for the cache a reopened agent replays. */
  private readonly items = new Map<string, ProviderTimelineItem>();
  private task: Task | null;
  private model: string;
  private mode: string;
  private cursor: string | null = null;
  private saving: Promise<void> = Promise.resolve();
  private inputs: TaskInput | null = null;
  private readonly inputFor: (task: Task) => TaskInput;
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
    this.cache = options.cache;
    this.inputFor = options.inputFor ?? ((task) => taskInput(this.api, task, this.log));
    this.emit = options.emit;
    this.log = options.log;
  }

  /**
   * Starts following the task.
   * - `catchUp`: a task a link just opened. The first poll emits its whole history as live events:
   *   Paseo drops timeline items a new agent emits while opening.
   * - `reopen`: an agent Paseo restores or reloads. Paseo rebuilds its timeline from what the provider
   *   emits while opening, so this replays the cached timeline (instant) and polls from its cursor.
   *   Without a cache (agents from older versions) it reads the whole history first, which for a long
   *   task takes close to Paseo's 60 s refresh deadline.
   */
  async attach(options: { catchUp: true } | { reopen: { replay: boolean } }): Promise<void> {
    if (!this.task) return;
    if ("catchUp" in options) {
      this.schedule(ACTIVE_POLL_MS);
      return;
    }
    const { replay } = options.reopen;
    const snapshot = await this.cache.load(this.task.id);
    if (snapshot) {
      for (const item of snapshot.items) {
        this.items.set(item.id, item);
        if (replay) this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
      }
      for (const request of snapshot.pending) this.pending.set(request.requestId, request);
      this.cursor = snapshot.cursor;
    } else {
      const events = await this.api.allEvents(this.task.id, null);
      for (const event of events) {
        const mapped = this.mapper.map(event);
        for (const item of mapped.items) (replay ? this.emitItem(item) : this.items.set(item.id, item));
        this.track(mapped.request, mapped.resolves, mapped.mode);
      }
      for (const item of this.mapper.closeOpenTools("completed")) (replay ? this.emitItem(item) : this.items.set(item.id, item));
      this.cursor = events.at(-1)?.id ?? null;
      this.save();
    }
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
    const turnId = randomUUID();
    const deliver = async () => {
      const question = [...this.pending.values()].find((request) => request.kind === "question");
      if (!this.task) await this.createTask(text, turnId);
      else if (question) {
        await this.input().answerQuestion(question, text);
        this.resolve(question.requestId);
      } else await this.input().sendMessage(text, { ...this.modelField(), turnId });
    };
    // The relay may have to wake a dormant sandbox first, which can take longer than Paseo waits for a
    // prompt to be accepted, so sandbox input is acknowledged at once and delivered in the background.
    const viaRelay = this.task ? taskKind(this.task) === "sandbox" : this.mode !== PULL_REQUEST_MODE;
    const answersQuestion = [...this.pending.values()].some((request) => request.kind === "question");
    if (!viaRelay) {
      try {
        await deliver();
      } catch (error) {
        this.promptResult(prompt, { type: "failed", error: { message: errorMessage(error) } });
        return;
      }
    }
    // A relay message comes back keyed by its turn id; a REST one is matched by text (see consumeEcho).
    const relayTurn = viaRelay && !answersQuestion;
    if (!relayTurn) this.echoes.push(text);
    this.emitItem({
      type: "user_message",
      id: relayTurn ? `user:turn:${turnId}` : `user:${prompt.clientMessageId}`,
      text,
      clientMessageId: prompt.clientMessageId,
    });
    const turn = this.turn ?? this.beginTurn(false);
    this.promptResult(prompt, this.turn === turn && turn.sawBusy ? { type: "steer", turnId: turn.id } : { type: "turn", turnId: turn.id });
    if (viaRelay) void this.deliverInBackground(prompt.clientMessageId, deliver);
    this.schedule(ACTIVE_POLL_MS);
  }

  private async deliverInBackground(id: string, deliver: () => Promise<void>): Promise<void> {
    const slow = setTimeout(
      () => this.emitItem({ type: "notification", id: `waking:${id}`, level: "info", message: "Waking the cloud sandbox…" }),
      WAKE_NOTICE_MS,
    );
    try {
      await deliver();
    } catch (error) {
      this.emitItem({ type: "error", id: `delivery:${id}`, message: `Couldn't send this to GitHub: ${errorMessage(error)}` });
      if (this.turn) this.finishTurn("failed");
    } finally {
      clearTimeout(slow);
    }
  }

  async interrupt(): Promise<void> {
    if (!this.task) return;
    if (this.turn) this.turn.interruptRequested = true;
    await this.input().abort();
    this.schedule(ACTIVE_POLL_MS);
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (changes.model !== undefined) this.model = changes.model ?? DEFAULT_MODEL;
    if (changes.mode && changes.mode !== this.mode) {
      // A new agent's mode only picks the kind of task its first message starts.
      if (this.task) {
        if (changes.mode === PULL_REQUEST_MODE || taskKind(this.task) !== "sandbox") {
          throw new Error("A task can't switch between the sandbox and the pull-request agent");
        }
        await this.input().setMode(changes.mode);
      }
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
        const action = allow ? (response.selectedActionId?.replace(/^plan:/, "") ?? request.actions?.[0] ?? null) : null;
        const feedback = response.behavior === "deny" ? response.message : undefined;
        await this.input().answerPlan(request, action, feedback);
        return;
      }
      case "question": {
        // The card answers in `updatedInput.answers`; a plain allow (e.g. `paseo permit allow`) takes the first choice.
        const fromCard = response.behavior === "allow" ? cardAnswer(response.updatedInput) : null;
        const answer = allow ? (fromCard ?? request.choices?.[0] ?? null) : null;
        await this.input().answerQuestion(request, answer);
        return;
      }
      case "permission":
        await this.input().confirmPermission(request, allow);
        return;
    }
  }

  /** Stops following the task. The task keeps running on GitHub. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.inputs?.close();
  }

  private input(): TaskInput {
    if (!this.task) throw new Error("The task has not started yet");
    this.inputs ??= this.inputFor(this.task);
    return this.inputs;
  }

  /** Starts the task: the pull-request agent over REST, an interactive sandbox over the relay. */
  private async createTask(prompt: string, turnId: string): Promise<void> {
    if (!this.repo) throw new Error("No repository to start the task on");
    const repositories = [{ owner: this.repo.owner, name: this.repo.name }];
    if (this.mode === PULL_REQUEST_MODE) {
      this.task = await this.api.createTask({ prompt, repositories, ...this.modelField() });
    } else {
      // Mission Control starts no run for a sandbox task; the client sends the first turn over the relay.
      const created = await this.api.createTask({ prompt, repositories, environment_id: "github-sandbox" });
      this.task = await this.waitForEnvironment(created.id);
      if (this.mode !== DEFAULT_MODE) await this.input().setMode(this.mode);
      await this.input().sendMessage(prompt, { turnId });
    }
    this.emit({ type: "session.persistence", sessionId: this.sessionId, persistence: { version: 1, data: { taskId: this.task.id } } });
    this.publishConfig();
    this.save();
    // The prompt scheduled its poll before the task existed; start following it now.
    this.schedule(ACTIVE_POLL_MS);
  }

  /** A new sandbox task gets its environment and session a few seconds after it is created. */
  private async waitForEnvironment(taskId: string): Promise<Task> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const task = await this.api.getTask(taskId);
      if (task.sessions?.at(-1)?.environment_id) return task;
      if (Date.now() > deadline) throw new Error("GitHub didn't assign the cloud sandbox in time. Try again.");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  /** Writes the cache a reopened agent replays. Writes run one at a time, in order. */
  private save(): void {
    const task = this.task;
    if (!task) return;
    const snapshot = { cursor: this.cursor, pending: [...this.pending.values()], items: [...this.items.values()] };
    this.saving = this.saving
      .then(() => this.cache.save(task.id, snapshot))
      .catch((error) => this.log(`saving the task cache failed: ${errorMessage(error)}`));
  }

  private modelField(): { model?: string } {
    return this.model && this.model !== "auto" ? { model: this.model } : {};
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
    if (events.length > 0) {
      this.cursor = events.at(-1)!.id;
      this.save();
    }
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
                // Paseo's question card reads `input.questions` and answers in `updatedInput.answers[header]`.
                id: request.requestId,
                name: "Question",
                kind: "question",
                title: request.title,
                input: {
                  questions: [
                    {
                      question: request.title,
                      header: QUESTION_HEADER,
                      options: (request.choices ?? []).map((label) => ({ label })),
                      multiSelect: false,
                      allowOther: true,
                    },
                  ],
                },
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
    // Paseo shows a card only inside a running turn, so a request keeps (or opens) one until answered.
    const waiting = this.pending.size > 0;
    if (!this.turn) {
      if (!resting || waiting) this.beginTurn(true);
      return;
    }
    if (waiting && state !== "cancelled" && state !== "failed" && state !== "timed_out") return;
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
    this.emit({ type: "session.config", sessionId: this.sessionId, config: configState(this.model, this.mode, this.models, taskKind(this.task)) });
  }

  private promptResult(
    prompt: ProviderPrompt,
    result: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"],
  ): void {
    this.emit({ type: "session.prompt_result", sessionId: this.sessionId, clientMessageId: prompt.clientMessageId, result });
  }

  private emitItem(item: ProviderTimelineItem): void {
    this.items.set(item.id, item);
    this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
  }
}


function cardAnswer(updatedInput: unknown): string | null {
  const answers = (updatedInput as { answers?: Record<string, unknown> } | undefined)?.answers;
  const answer = answers?.[QUESTION_HEADER];
  return typeof answer === "string" && answer.trim() ? answer.trim() : null;
}

function lastSessionError(task: Task | null): string {
  const session = task?.sessions?.at(-1);
  return session?.error?.message || `The task ${task?.state ?? "failed"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
