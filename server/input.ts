import type { CopilotTasksApi, SteerRequest, Task } from "./api";
import { RelayLink, type ChatInputQuestion } from "./relay/link";
import type { PendingRequest } from "./timeline";

/**
 * How a Paseo agent sends input to its task. The coding agent (`copilot-developer`, opens a PR) takes
 * REST steer calls. Interactive sandbox tasks (`copilot-developer-cli`, the github.com "Agents" chat)
 * take input only over their relay.
 */
export interface TaskInput {
  /** `turnId` names the relay turn, so the task's echo of the message lands on the same timeline item. */
  sendMessage(text: string, options?: { model?: string; turnId?: string }): Promise<void>;
  /** `answer` null skips the question. */
  answerQuestion(request: PendingRequest, answer: string | null): Promise<void>;
  /** `action` null rejects the plan, optionally with feedback. */
  answerPlan(request: PendingRequest, action: string | null, feedback?: string): Promise<void>;
  confirmPermission(request: PendingRequest, approved: boolean): Promise<void>;
  abort(): Promise<void>;
  setMode(mode: string): Promise<void>;
  close(): void;
}

/** Whether a task runs in the interactive sandbox rather than as the PR coding agent. */
export function isSandboxTask(task: Task): boolean {
  return (
    task.current_environment?.kind === "managed-sandbox" ||
    task.compute?.provider === "sandboxes" ||
    (task.agent_collaborators ?? []).some((agent) => agent.slug === "copilot-developer-cli")
  );
}

export function taskInput(api: CopilotTasksApi, task: Task, log: (message: string) => void): TaskInput {
  if (!isSandboxTask(task)) return new RestInput(api, task);
  const session = task.sessions?.at(-1);
  const environmentId = session?.environment_id ?? task.current_environment?.id;
  if (!environmentId) throw new Error("The cloud sandbox has no environment yet");
  const fullName = task.repository?.full_name ?? task.repositories?.[0]?.full_name;
  const [owner, name] = fullName?.split("/") ?? [];
  return new RelayInput(
    new RelayLink(api, environmentId, session?.ahp_resource_uri ?? `ahp-session:/${session?.id}`, log, owner && name ? { owner, name } : undefined),
  );
}

class RestInput implements TaskInput {
  constructor(
    private readonly api: CopilotTasksApi,
    private readonly task: Task,
  ) {}

  sendMessage(text: string, options: { model?: string } = {}): Promise<void> {
    return this.steer({ type: "user_message", content: text, ...(options.model ? { model: options.model } : {}) });
  }

  answerQuestion(request: PendingRequest, answer: string | null): Promise<void> {
    return this.steer({
      type: "ask_user_response",
      content: JSON.stringify(
        answer === null
          ? { requestId: request.requestId, skipped: true }
          : { requestId: request.requestId, answer, wasFreeform: !(request.choices ?? []).includes(answer) },
      ),
    });
  }

  answerPlan(_request: PendingRequest, action: string | null, feedback?: string): Promise<void> {
    return this.steer({
      type: "plan_approval_response",
      content: JSON.stringify({
        approved: action !== null,
        ...(action ? { selectedAction: action } : {}),
        ...(action === null && feedback ? { feedback } : {}),
      }),
      event_identifiers: [action !== null ? "plan_approved" : "plan_dismissed"],
    });
  }

  confirmPermission(request: PendingRequest, approved: boolean): Promise<void> {
    return this.steer({
      type: "permission_response",
      content: JSON.stringify({ promptId: request.toolCallId ?? request.requestId, approved }),
    });
  }

  abort(): Promise<void> {
    return this.steer({ type: "abort" });
  }

  setMode(): Promise<void> {
    return Promise.reject(new Error("The pull-request coding agent has no modes"));
  }

  close(): void {}

  private async steer(request: SteerRequest): Promise<void> {
    try {
      await this.api.steer(this.task.id, request);
    } catch (error) {
      if (/not steerable/i.test(error instanceof Error ? error.message : String(error))) {
        throw new Error(`GitHub doesn't accept input for this task right now. Reply on github.com: ${taskUrl(this.task)}`);
      }
      throw error;
    }
  }
}

class RelayInput implements TaskInput {
  constructor(private readonly link: RelayLink) {}

  async sendMessage(text: string, options: { turnId?: string } = {}): Promise<void> {
    await this.link.sendMessage(text, options.turnId);
  }

  async answerQuestion(request: PendingRequest, answer: string | null): Promise<void> {
    if (answer === null) return this.link.completeInput(request.requestId, "decline");
    const live = await this.link.findInput(request.requestId);
    if (!live) throw new Error("That question is no longer waiting for an answer");
    const answers: Record<string, unknown> = {};
    const [first, ...rest] = live.request.questions ?? [];
    if (first) answers[first.id] = answerFor(first, answer);
    for (const question of rest) answers[question.id] = { state: "skipped" };
    await this.link.completeInput(request.requestId, "accept", answers);
  }

  async answerPlan(request: PendingRequest, action: string | null, feedback?: string): Promise<void> {
    const live = await this.link.findInput(request.requestId);
    if (!live) throw new Error("That plan is no longer waiting for review");
    const questions = live.request.questions ?? [];
    const selected = questions.find((question) => question.id === "selectedAction") ?? questions[0];
    const feedbackQuestion = questions.find((question) => question.id === "feedback");
    if (action === null) {
      await this.link.completeInput(
        request.requestId,
        "decline",
        feedback && feedbackQuestion ? { [feedbackQuestion.id]: submitted({ kind: "text", value: feedback }) } : undefined,
      );
      return;
    }
    if (!selected) throw new Error("The plan review has no actions to pick from");
    await this.link.completeInput(request.requestId, "accept", {
      [selected.id]: submitted({ kind: "selected", value: action }),
      ...(feedbackQuestion ? { [feedbackQuestion.id]: { state: "skipped" } } : {}),
    });
  }

  confirmPermission(request: PendingRequest, approved: boolean): Promise<void> {
    if (!request.toolCallId) throw new Error("That permission request has no tool call to confirm");
    return this.link.confirmToolCall(request.toolCallId, approved);
  }

  abort(): Promise<void> {
    return this.link.cancelTurn();
  }

  setMode(mode: string): Promise<void> {
    return this.link.setMode(mode);
  }

  close(): void {
    this.link.close();
  }
}

/** An AHP answer for one question: an option the text names, else free text. */
export function answerFor(question: ChatInputQuestion, answer: string): unknown {
  const option = question.options?.find((candidate) => candidate.label === answer || candidate.id === answer);
  if (option) return submitted({ kind: question.kind === "multi-select" ? "selected-many" : "selected", value: question.kind === "multi-select" ? [option.id] : option.id });
  if (question.kind === "single-select" || question.kind === "multi-select") {
    return submitted({ kind: question.kind === "multi-select" ? "selected-many" : "selected", value: question.kind === "multi-select" ? [] : "", freeformValues: [answer] });
  }
  return submitted({ kind: "text", value: answer });
}

function submitted(value: Record<string, unknown>) {
  return { state: "submitted", value };
}

export function taskUrl(task: Task): string {
  const repo = task.repository?.full_name ?? task.repositories?.[0]?.full_name;
  return task.html_url ?? (repo ? `https://github.com/${repo}/tasks/${task.id}` : "https://github.com/copilot/agents");
}
