import { describe, expect, it } from "vitest";
import { nextCursor, type TaskEvent } from "./api";
import { TimelineMapper } from "./timeline";
import { parseTaskUrl, remoteMatches } from "../shared/task-url";

let seq = 0;
function event(type: string, data: Record<string, unknown> = {}, extra: Partial<TaskEvent> = {}): TaskEvent {
  return { id: `e${++seq}`, timestamp: "2026-11-27T00:00:00Z", parentId: null, type, data, ...extra };
}

describe("TimelineMapper", () => {
  it("shows the user's prompt but not prompts the runtime injects", () => {
    const mapper = new TimelineMapper();
    expect(mapper.map(event("user.message", { content: "fix it", transformedContent: "<system>fix it" })).items).toEqual([
      expect.objectContaining({ type: "user_message", text: "fix it" }),
    ]);
    expect(mapper.map(event("user.message", { content: "write a PR body", transformedContent: "write a PR body" })).items).toEqual([]);
    expect(mapper.map(event("user.message", { content: "go", source: "autopilot" })).items).toEqual([]);
  });

  it("keeps a re-sent assistant message in one item", () => {
    const mapper = new TimelineMapper();
    const first = mapper.map(event("assistant.message", { messageId: "m1", content: "Hel" })).items[0];
    const second = mapper.map(event("assistant.message", { messageId: "m1", content: "Hello" })).items[0];
    expect(first.id).toBe(second.id);
    expect(second).toMatchObject({ type: "assistant_message", text: "Hello" });
  });

  it("maps a tool call from start to result, and closes ones that never complete", () => {
    const mapper = new TimelineMapper();
    expect(mapper.map(event("tool.execution_start", { toolCallId: "t1", toolName: "bash", arguments: { command: "ls" } })).items[0]).toMatchObject({
      type: "tool_call",
      status: "running",
      detail: { type: "shell", command: "ls" },
    });
    expect(mapper.map(event("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: "a\nb" } })).items[0]).toMatchObject({
      status: "completed",
      detail: { type: "shell", command: "ls", output: "a\nb" },
    });
    mapper.map(event("tool.execution_start", { toolCallId: "setup", toolName: "run_setup", arguments: {} }));
    expect(mapper.closeOpenTools("completed")).toEqual([expect.objectContaining({ callId: "setup", status: "completed" })]);
  });

  it("hides sub-agent internals and dismissed input", () => {
    const mapper = new TimelineMapper();
    expect(mapper.map(event("assistant.message", { content: "x", parentToolCallId: "t" })).items).toEqual([]);
    expect(mapper.map(event("assistant.message", { content: "x" }, { agentId: "t" })).items).toEqual([]);
    expect(mapper.map(event("user.message", { content: "x" }, { dismissed: true })).items).toEqual([]);
  });

  it("turns plan, question and permission requests into requests, resolved by their completions", () => {
    const mapper = new TimelineMapper();
    const plan = mapper.map(event("exit_plan_mode.requested", { requestId: "p1", planContent: "# Plan", actions: ["autopilot", "interactive", "exit_only"] }));
    expect(plan.items[0]).toMatchObject({ type: "assistant_message", text: "# Plan" });
    expect(plan.request).toMatchObject({ kind: "plan", requestId: "p1", actions: ["autopilot", "interactive", "exit_only"] });
    expect(mapper.map(event("user_input.requested", { requestId: "q1", question: "Which?", choices: ["A", "B"] })).request).toMatchObject({
      kind: "question",
      choices: ["A", "B"],
    });
    expect(
      mapper.map(event("permission.requested", { requestId: "r1", permissionRequest: { toolCallId: "t9", commandSegments: [{ fullCommandText: "rm x" }] } })).request,
    ).toMatchObject({ kind: "permission", toolCallId: "t9", title: "Allow `rm x` in the cloud sandbox?" });
    expect(mapper.map(event("exit_plan_mode.completed", { requestId: "p1", approved: true })).resolves).toBe("p1");
    expect(mapper.map(event("session.mode_changed", { newMode: "plan" })).mode).toBe("plan");
  });
});

describe("helpers", () => {
  it("reads the next-page cursor from the Link header", () => {
    expect(nextCursor('</api/v1/agents/tasks/x/events?after=abc&per_page=100>; rel="next"')).toBe("abc");
    expect(nextCursor(null)).toBeNull();
  });

  it("recognises task links and matching remotes", () => {
    expect(parseTaskUrl("https://github.com/fullstackhouse/casteo/tasks/B2E859D1-d47f-4866-8203-40778430dac2?x=1")).toEqual({
      owner: "fullstackhouse",
      repo: "casteo",
      taskId: "b2e859d1-d47f-4866-8203-40778430dac2",
    });
    expect(parseTaskUrl("https://github.com/fullstackhouse/casteo/pull/12")).toBeNull();
    expect(remoteMatches("git@github.com:FullStackHouse/casteo.git", "fullstackhouse", "casteo")).toBe(true);
    expect(remoteMatches("https://github.com/fullstackhouse/casteo-other", "fullstackhouse", "casteo")).toBe(false);
  });
});
