import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { CopilotTasksApi, CreateTaskRequest, SteerRequest, Task, TaskEvent } from "./api";
import type { TaskCache, TaskSnapshot } from "./cache";
import { CloudTaskSession } from "./session";

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
      mode: "default",
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

    await session.respondToPermission("q1", { behavior: "allow", selectedActionId: "choice:A" });
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
