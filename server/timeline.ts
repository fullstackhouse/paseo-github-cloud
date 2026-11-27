import type { ProviderTimelineItem, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import type { TaskEvent } from "./api";

/**
 * Pure mapping from cloud task events (the Copilot SDK session event schema) to Paseo timeline
 * items. Shared by replay and the live poll.
 */

export interface PendingRequest {
  kind: "plan" | "question" | "permission";
  requestId: string;
  /** Tool call the request belongs to, for permission answers. */
  toolCallId?: string;
  title: string;
  description?: string;
  choices?: string[];
  actions?: string[];
}

export interface MappedEvent {
  items: ProviderTimelineItem[];
  /** A request the agent waits on, until a matching `*.completed` event resolves it. */
  request?: PendingRequest;
  /** The request id a `*.completed` event resolves. */
  resolves?: string;
  /** The agent's mode changed. */
  mode?: string;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export class TimelineMapper {
  private readonly tools = new Map<string, ToolCall>();
  private readonly openTools = new Set<string>();

  map(event: TaskEvent): MappedEvent {
    if (event.dismissed || event.pending) return { items: [] };
    const data = event.data ?? {};
    // Sub-agent internals: the parent tool call already shows the sub-agent's work.
    if (event.agentId || typeof data.parentToolCallId === "string") return { items: [] };

    switch (event.type) {
      case "user.message": {
        if (!isUserAuthored(data)) return { items: [] };
        return { items: [{ type: "user_message", id: event.id, text: str(data.content) }] };
      }
      case "assistant.message": {
        const text = str(data.content).trim();
        if (!text) return { items: [] };
        // The API re-sends a message with growing content under one messageId; one item id keeps it in place.
        return { items: [{ type: "assistant_message", id: `msg:${str(data.messageId) || event.id}`, text }] };
      }
      case "assistant.reasoning": {
        const text = str(data.content).trim();
        if (!text) return { items: [] };
        return { items: [{ type: "reasoning", id: `reasoning:${str(data.reasoningId) || event.id}`, text }] };
      }
      case "tool.execution_start": {
        const id = str(data.toolCallId) || event.id;
        const name = str(data.mcpToolName) || str(data.toolName) || "tool";
        const input = record(data.arguments);
        this.tools.set(id, { name, input });
        this.openTools.add(id);
        return { items: [toolItem(id, { name, input }, "running", null)] };
      }
      case "tool.execution_complete": {
        const id = str(data.toolCallId);
        const call = this.tools.get(id);
        if (!call) return { items: [] };
        this.openTools.delete(id);
        const result = record(data.result);
        const error = record(data.error);
        const output = str(result.content) || str(error.message) || null;
        return { items: [toolItem(id, call, data.success === false ? "failed" : "completed", output)] };
      }
      case "session.compaction_complete":
        return { items: [{ type: "compaction", id: event.id, status: "completed", trigger: "auto" }] };
      case "session.error":
        return {
          items: [{ type: "error", id: event.id, message: str(data.message) || str(data.errorType) || "Session error" }],
        };
      case "session.mode_changed":
        return { items: [], mode: str(data.newMode) || undefined };
      case "exit_plan_mode.requested": {
        const plan = str(data.planContent);
        return {
          items: plan ? [{ type: "assistant_message", id: `plan:${event.id}`, text: plan }] : [],
          request: {
            kind: "plan",
            requestId: str(data.requestId) || event.id,
            title: "Approve the plan?",
            actions: strings(data.actions),
          },
        };
      }
      case "user_input.requested":
        return {
          items: [],
          request: {
            kind: "question",
            requestId: str(data.requestId) || event.id,
            toolCallId: str(data.toolCallId) || undefined,
            title: str(data.question) || "The agent has a question",
            choices: strings(data.choices),
          },
        };
      case "permission.requested": {
        const request = record(data.permissionRequest);
        return {
          items: [],
          request: {
            kind: "permission",
            requestId: str(data.requestId) || event.id,
            toolCallId: str(request.toolCallId) || undefined,
            title: permissionTitle(request),
          },
        };
      }
      case "exit_plan_mode.completed":
      case "user_input.completed":
      case "permission.completed":
        return { items: [], resolves: str(data.requestId) || undefined };
      default:
        return { items: [] };
    }
  }

  /** Tool calls still running when a turn ends; some (e.g. `run_setup`) never report completion. */
  closeOpenTools(status: "completed" | "canceled"): ProviderTimelineItem[] {
    const items = [...this.openTools].map((id) => toolItem(id, this.tools.get(id)!, status, null));
    this.openTools.clear();
    return items;
  }
}

/** The SDK re-sends injected prompts (setup, PR descriptions, sub-agent prompts) as user messages. */
function isUserAuthored(data: Record<string, unknown>): boolean {
  if (typeof data.source === "string" && data.source) return false;
  const transformed = str(data.transformedContent);
  return !transformed || transformed !== str(data.content);
}

function toolItem(
  id: string,
  call: ToolCall,
  status: "running" | "completed" | "failed" | "canceled",
  output: string | null,
): ProviderTimelineItem {
  const detail = toolDetail(call.name, call.input, output);
  return status === "failed"
    ? { type: "tool_call", id: `tool:${id}`, callId: id, name: call.name, detail, status, error: output ?? "failed" }
    : { type: "tool_call", id: `tool:${id}`, callId: id, name: call.name, detail, status, error: null };
}

export function toolDetail(name: string, input: Record<string, unknown>, output: string | null): ProviderToolCallDetail {
  const s = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  const withOutput = output !== null ? { output } : {};
  switch (name) {
    case "bash":
    case "shell":
      return { type: "shell", command: s("command") ?? "", ...withOutput };
    case "view":
    case "read":
      return { type: "read", filePath: s("path") ?? s("file_path") ?? "", ...(output !== null ? { content: output } : {}) };
    case "create":
      return { type: "write", filePath: s("path") ?? "", content: s("file_text") ?? s("content") };
    case "edit":
    case "str_replace":
    case "str_replace_editor":
      return { type: "edit", filePath: s("path") ?? "", oldString: s("old_str"), newString: s("new_str") };
    case "grep":
    case "glob":
      return { type: "search", query: s("pattern") ?? "", toolName: name, ...(output !== null ? { content: output } : {}) };
    default:
      return { type: "unknown", input: input as never, output };
  }
}

function permissionTitle(request: Record<string, unknown>): string {
  const segments = Array.isArray(request.commandSegments) ? request.commandSegments : [];
  const command = segments
    .map((segment) => str(record(segment).fullCommandText))
    .filter(Boolean)
    .join(" && ");
  if (command) return `Allow \`${command.slice(0, 200)}\` in the cloud sandbox?`;
  const kind = str(request.kind);
  return kind ? `Allow ${kind} in the cloud sandbox?` : "Allow this action in the cloud sandbox?";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
