import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { CopilotTasksApi, CreateTaskRequest, SteerRequest, Task, TaskEvent } from "./api";
import type { TaskCache, TaskSnapshot } from "./cache";
import type { TaskInput } from "./input";
import { CloudTaskSession, PULL_REQUEST_MODE } from "./session";

class MemoryCache implements TaskCache {
  readonly snapshots = new Map<string, TaskSnapshot>();
  async load(taskId: string) {
    return structuredClone(this.snapshots.get(taskId) ?? null);
  }
  async save(taskId: string, snapshot: TaskSnapshot) {
    this.snapshots.set(taskId, structuredClone(snapshot));
  }
}

class FakeApi {
  task: Task = { id: "task-1", state: "queued", remote_steerable: true, sessions: [] };
  events: TaskEvent[] = [];
  created: CreateTaskRequest[] = [];
  steers: SteerRequest[] = [];

  async createTask(request: CreateTaskRequest) {
    this.created.push(request);
    return this.task;
  }
  async getTask() {
    return this.task;
  }
  async steer(_id: string, request: SteerRequest) {
    this.steers.push(request);
  }
  async allEvents(_id: string, after: string | null) {
    const start = after ? this.events.findIndex((event) => event.id === after) + 1 : 0;
    return this.events.slice(start);
  }
  push(type: string, data: Record<string, unknown> = {}) {
    this.events.push({ id: `e${this.events.length + 1}`, timestamp: "", parentId: null, type, data });
  }
}

class RecordingInput implements TaskInput {
  readonly calls: unknown[][] = [];
  readonly turnIds: string[] = [];
  async sendMessage(text: string, options: { turnId?: string } = {}) {
    if (options.turnId) this.turnIds.push(options.turnId);
    this.calls.push(["sendMessage", text]);
  }
  async answerQuestion(request: { requestId: string }, answer: string | null) { this.calls.push(["answerQuestion", request.requestId, answer]); }
  async answerPlan(request: { requestId: string }, action: string | null, feedback?: string) { this.calls.push(["answerPlan", request.requestId, action, feedback]); }
  async confirmPermission(request: { requestId: string }, approved: boolean) { this.calls.push(["confirmPermission", request.requestId, approved]); }
  async abort() { this.calls.push(["abort"]); }
  async setMode(mode: string) { this.calls.push(["setMode", mode]); }
  close() { this.calls.push(["close"]); }
}

function prompt(text: string, id = "c1") {
  return { clientMessageId: id, delivery: "auto" as const, input: { type: "message" as const, content: [{ type: "text" as const, text }] } };
}

describe("CloudTaskSession", () => {
  let api: FakeApi;
  let cache: MemoryCache;
  let events: ProviderEvent[];
  let session: CloudTaskSession;

  beforeEach(() => {
    vi.useFakeTimers();
    api = new FakeApi();
    cache = new MemoryCache();
    events = [];
    session = new CloudTaskSession({
      api: api as unknown as CopilotTasksApi,
      paseoSessionId: "s1",
      task: null,
      repo: { owner: "acme", name: "app" },
      model: "claude-opus-5.5",
      mode: PULL_REQUEST_MODE,
      cache,
      emit: (event) => events.push(event),
      log: () => {},
    });
  });
  afterEach(() => {
    session.stop();
    vi.useRealTimers();
  });

  const turns = () => events.filter((event) => event.type === "session.turn").map((event) => (event as { state: string }).state);

  it("starts a task on the first prompt, follows it, and ends the turn when it rests", async () => {
    await session.prompt(prompt("Fix the bug"));
    expect(api.created).toEqual([{ prompt: "Fix the bug", repositories: [{ owner: "acme", name: "app" }], model: "claude-opus-5.5" }]);
    expect(events).toContainEqual({
      type: "session.persistence",
      sessionId: "s1",
      persistence: { version: 1, data: { taskId: "task-1" } },
    });

    api.task = { ...api.task, state: "in_progress" };
    api.push("user.message", { content: "Fix the bug", transformedContent: "<ctx>Fix the bug" });
    api.push("assistant.message", { messageId: "m1", content: "Done." });
    await vi.advanceTimersByTimeAsync(2_000);
    api.task = { ...api.task, state: "completed" };
    await vi.advanceTimersByTimeAsync(2_000);

    const texts = events.flatMap((event) => (event.type === "timeline.item" ? [`${event.item.type}:${"text" in event.item ? event.item.text : ""}`] : []));
    // The echoed prompt is not drawn twice.
    expect(texts).toEqual(["user_message:Fix the bug", "assistant_message:Done."]);
    expect(turns()).toEqual(["started", "completed"]);
  });

  it("steers follow-ups into the task, and steers a running turn without a new one", async () => {
    await session.prompt(prompt("First"));
    api.task = { ...api.task, state: "in_progress" };
    await vi.advanceTimersByTimeAsync(2_000);
    await session.prompt({ ...prompt("Also this", "c2"), delivery: "steer" });
    expect(api.steers).toEqual([{ type: "user_message", content: "Also this", model: "claude-opus-5.5" }]);
    expect(events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "c2", result: expect.objectContaining({ type: "steer" }) }));
    await session.interrupt();
    expect(api.steers.at(-1)).toEqual({ type: "abort" });
    api.task = { ...api.task, state: "cancelled" };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(turns()).toEqual(["started", "canceled"]);
  });

  it("streams an existing task's history as live events when a link opens it", async () => {
    api.task = { ...api.task, state: "completed" };
    api.push("user.message", { content: "Old prompt", transformedContent: "<ctx>Old prompt" });
    api.push("assistant.message", { messageId: "m1", content: "Old answer" });
    const linked = new CloudTaskSession({
      api: api as unknown as CopilotTasksApi,
      paseoSessionId: "s2",
      task: api.task,
      repo: null,
      model: "auto",
      mode: "default",
      cache,
      emit: (event) => events.push(event),
      log: () => {},
    });
    await linked.attach({ catchUp: true });
    // Nothing during open: Paseo drops a new agent's opening timeline items.
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events.filter((event) => event.type === "timeline.item").map((event) => (event as { item: { text: string } }).item.text)).toEqual([
      "Old prompt",
      "Old answer",
    ]);
    await linked.prompt(prompt("Follow-up"));
    expect(api.steers).toEqual([{ type: "user_message", content: "Follow-up" }]);
    linked.stop();
  });

  const texts = () => events.flatMap((event) => (event.type === "timeline.item" && "text" in event.item ? [event.item.text] : []));

  function reopened(sessionId: string) {
    return new CloudTaskSession({
      api: api as unknown as CopilotTasksApi,
      paseoSessionId: sessionId,
      task: api.task,
      repo: null,
      model: "auto",
      mode: "default",
      cache,
      emit: (event) => events.push(event),
      log: () => {},
    });
  }

  it("reopens from its cache: replays what it showed, reads only newer events, re-raises open requests", async () => {
    api.task = { ...api.task, state: "waiting_for_user" };
    api.push("user.message", { content: "Old", transformedContent: "<ctx>Old" });
    api.push("user_input.requested", { requestId: "q1", question: "Pick A or B", choices: ["A", "B"] });
    const first = reopened("s3");
    await first.attach({ catchUp: true });
    await vi.advanceTimersByTimeAsync(2_000);
    first.stop();
    expect(cache.snapshots.get("task-1")).toMatchObject({ cursor: "e2", pending: [{ requestId: "q1" }] });

    events = [];
    const reads: Array<string | null> = [];
    const allEvents = api.allEvents.bind(api);
    api.allEvents = async (id: string, after: string | null) => {
      reads.push(after);
      return allEvents(id, after);
    };
    api.push("assistant.message", { messageId: "m9", content: "New answer" });
    const second = reopened("s4");
    await second.attach({ reopen: { replay: true } });
    // Replayed while opening, before any request to GitHub.
    expect(texts()).toEqual(["Old"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "session.permission", request: expect.objectContaining({ id: "q1" }) }));
    expect(reads).toEqual([]);

    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual(["e2"]);
    expect(texts()).toEqual(["Old", "New answer"]);
    second.stop();
  });

  it("reopens an agent without a cache by reading the whole history, then caches it", async () => {
    api.task = { ...api.task, state: "completed" };
    api.push("user.message", { content: "Old", transformedContent: "<ctx>Old" });
    api.push("assistant.message", { messageId: "m1", content: "Old answer" });
    const resumed = reopened("s5");
    await resumed.attach({ reopen: { replay: true } });
    expect(texts()).toEqual(["Old", "Old answer"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.snapshots.get("task-1")).toMatchObject({ cursor: "e2", items: [{ text: "Old" }, { text: "Old answer" }] });
    resumed.stop();
  });

  it("explains a refused steer and keeps the card when an idle interactive task rejects input", async () => {
    await session.prompt(prompt("Plan it"));
    api.task = { ...api.task, state: "idle", repository: { name: "app", full_name: "acme/app" } };
    api.push("user_input.requested", { requestId: "q1", question: "Pick A or B", choices: ["A", "B"] });
    await vi.advanceTimersByTimeAsync(2_000);
    api.steer = async () => {
      throw new Error("POST /tasks/task-1/steer failed (422): unprocessable: session is not steerable");
    };

    await session.respondToPermission("q1", { behavior: "allow", updatedInput: { answers: { Answer: "A" } } });
    expect(events).not.toContainEqual({ type: "session.permission_resolved", sessionId: "s1", permissionId: "q1" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "error", message: expect.stringContaining("https://github.com/acme/app/tasks/task-1") }),
      }),
    );

    await session.prompt(prompt("Hello", "c9"));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        clientMessageId: "c9",
        result: { type: "failed", error: { message: expect.stringContaining("Reply on github.com") } },
      }),
    );
  });

  describe("interactive sandbox tasks", () => {
    let input: RecordingInput;
    let sandbox: CloudTaskSession;

    function sandboxSession(mode: string, task: Task | null = null) {
      input = new RecordingInput();
      sandbox = new CloudTaskSession({
        api: api as unknown as CopilotTasksApi,
        paseoSessionId: "sb",
        task,
        repo: { owner: "acme", name: "app" },
        model: "auto",
        mode,
        cache,
        inputFor: () => input,
        emit: (event) => events.push(event),
        log: () => {},
      });
      return sandbox;
    }
    afterEach(() => sandbox?.stop());

    it("starts a sandbox task and sends its first message over the relay once the sandbox is assigned", async () => {
      sandboxSession("plan");
      api.task = { ...api.task, sessions: [] };
      const reads = [0];
      api.getTask = async () => {
        reads[0]++;
        return reads[0] < 2 ? api.task : { ...api.task, sessions: [{ id: "s", state: "queued", environment_id: "env-1" }] };
      };
      const sent = sandbox.prompt(prompt("Plan the refactor"));
      await vi.advanceTimersByTimeAsync(2_000);
      await sent;
      expect(api.created).toEqual([{ prompt: "Plan the refactor", repositories: [{ owner: "acme", name: "app" }], environment_id: "github-sandbox" }]);
      expect(input.calls).toEqual([["setMode", "plan"], ["sendMessage", "Plan the refactor"]]);
      expect(api.steers).toEqual([]);
      // The new task is followed, and its echo of the first message replaces Paseo's bubble.
      api.task = { ...api.task, state: "completed", sessions: [{ id: "s", state: "completed", environment_id: "env-1" }] };
      api.getTask = async () => api.task;
      api.push("user.message", { content: "Plan the refactor", transformedContent: "<ctx>Plan the refactor", clientTurnId: input.turnIds[0] });
      api.push("assistant.message", { messageId: "m1", content: "Here is the plan." });
      await vi.advanceTimersByTimeAsync(2_000);
      const items = events.flatMap((event) => (event.type === "timeline.item" ? [event.item] : []));
      expect(new Set(items.filter((item) => item.type === "user_message").map((item) => item.id))).toEqual(new Set([`user:turn:${input.turnIds[0]}`]));
      expect(items).toContainEqual(expect.objectContaining({ type: "assistant_message", text: "Here is the plan." }));
    });

    it("routes answers, plan reviews, permissions and stop through the task's input", async () => {
      api.task = { ...api.task, state: "in_progress", sessions: [{ id: "s", state: "in_progress", environment_id: "env-1" }] };
      sandboxSession("interactive", api.task);
      await sandbox.attach({ catchUp: true });
      api.push("user_input.requested", { requestId: "q1", question: "Pick A or B", choices: ["A", "B"] });
      api.push("exit_plan_mode.requested", { requestId: "p1", planContent: "# Plan", actions: ["autopilot", "interactive", "exit_only"] });
      api.push("permission.requested", { requestId: "r1", permissionRequest: { toolCallId: "t1" } });
      await vi.advanceTimersByTimeAsync(2_000);

      await sandbox.respondToPermission("q1", { behavior: "allow", updatedInput: { answers: { Answer: "A" } } });
      await sandbox.respondToPermission("p1", { behavior: "deny", message: "Smaller steps" });
      await sandbox.respondToPermission("r1", { behavior: "allow" });
      await sandbox.prompt(prompt("Keep going", "c2"));
      await sandbox.interrupt();
      expect(input.calls).toEqual([
        ["answerQuestion", "q1", "A"],
        ["answerPlan", "p1", null, "Smaller steps"],
        ["confirmPermission", "r1", true],
        ["sendMessage", "Keep going"],
        ["abort"],
      ]);
      expect(events).toContainEqual({ type: "session.permission_resolved", sessionId: "sb", permissionId: "q1" });
    });

    it("keeps a turn open while a card waits, so Paseo shows it, and closes it once answered", async () => {
      api.task = { ...api.task, state: "waiting_for_user", sessions: [{ id: "s", state: "idle", environment_id: "env-1" }] };
      sandboxSession("interactive", api.task);
      await sandbox.attach({ catchUp: true });
      api.push("user_input.requested", { requestId: "q1", question: "Pick A or B", choices: ["A", "B"] });
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(turns()).toEqual(["started"]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.permission",
          request: expect.objectContaining({
            kind: "question",
            input: { questions: [{ question: "Pick A or B", header: "Answer", options: [{ label: "A" }, { label: "B" }], multiSelect: false, allowOther: true }] },
          }),
        }),
      );

      await sandbox.respondToPermission("q1", { behavior: "allow" });
      expect(input.calls).toEqual([["answerQuestion", "q1", "A"]]);
      api.push("user_input.completed", { requestId: "q1", answer: "A" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(turns()).toEqual(["started", "completed"]);
    });

    it("draws a relayed message once: the task's echo replaces Paseo's bubble", async () => {
      api.task = { ...api.task, state: "idle", compute: { provider: "sandboxes" }, sessions: [{ id: "s", state: "idle", environment_id: "env-1" }] };
      sandboxSession("interactive", api.task);
      await sandbox.attach({ catchUp: true });
      await sandbox.prompt(prompt("Hello there", "c5"));
      await vi.advanceTimersByTimeAsync(0);
      api.push("user.message", { content: "Hello there", transformedContent: "<ctx>Hello there", clientTurnId: input.turnIds[0] });
      await vi.advanceTimersByTimeAsync(2_000);
      const userIds = new Set(
        events.flatMap((event) => (event.type === "timeline.item" && event.item.type === "user_message" ? [event.item.id] : [])),
      );
      expect(userIds).toEqual(new Set([`user:turn:${input.turnIds[0]}`]));
    });

    it("answers a pending question with the text typed in the composer", async () => {
      api.task = { ...api.task, state: "waiting_for_user", sessions: [{ id: "s", state: "idle", environment_id: "env-1" }] };
      sandboxSession("interactive", api.task);
      await sandbox.attach({ catchUp: true });
      api.push("user_input.requested", { requestId: "q1", question: "Name?", choices: [] });
      await vi.advanceTimersByTimeAsync(2_000);
      await sandbox.prompt(prompt("Ada", "c3"));
      expect(input.calls).toEqual([["answerQuestion", "q1", "Ada"]]);
    });
  });

  it("raises a plan approval and answers it through steer", async () => {
    await session.prompt(prompt("Plan it"));
    api.task = { ...api.task, state: "waiting_for_user" };
    api.push("exit_plan_mode.requested", { requestId: "p1", planContent: "# Plan", actions: ["autopilot", "interactive", "exit_only"] });
    await vi.advanceTimersByTimeAsync(2_000);
    const permission = events.find((event) => event.type === "session.permission");
    expect(permission).toMatchObject({ request: { id: "p1", kind: "plan" } });

    await session.respondToPermission("p1", { behavior: "allow", selectedActionId: "plan:autopilot" });
    expect(api.steers.at(-1)).toEqual({
      type: "plan_approval_response",
      content: JSON.stringify({ approved: true, selectedAction: "autopilot" }),
      event_identifiers: ["plan_approved"],
    });
    expect(events).toContainEqual({ type: "session.permission_resolved", sessionId: "s1", permissionId: "p1" });
  });
});
