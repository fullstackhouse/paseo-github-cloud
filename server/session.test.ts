import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { CopilotTasksApi, CreateTaskRequest, SteerRequest, Task, TaskEvent } from "./api";
import { CloudTaskSession } from "./session";

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
  let events: ProviderEvent[];
  let session: CloudTaskSession;

  beforeEach(() => {
    vi.useFakeTimers();
    api = new FakeApi();
    events = [];
    session = new CloudTaskSession({
      api: api as unknown as CopilotTasksApi,
      paseoSessionId: "s1",
      task: null,
      repo: { owner: "acme", name: "app" },
      model: "claude-opus-5.5",
      mode: "default",
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
    expect(events).toContainEqual({ type: "session.persistence", sessionId: "s1", persistence: { version: 1, data: { taskId: "task-1" } } });

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
