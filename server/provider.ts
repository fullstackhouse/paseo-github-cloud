import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderModel,
  type ProviderPersistence,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { CopilotTasksApi } from "./api";
import { readRepo } from "./repo";
import { fileTaskCache, type TaskCache } from "./cache";
import {
  CloudTaskSession,
  DEFAULT_MODE,
  DEFAULT_MODEL,
  MODELS,
  MODES,
  PULL_REQUEST_MODE,
  configState,
  taskKind,
} from "./session";

const CAPABILITIES = ["prompt.message", "prompt.steer", "session.persistence", "session.configure", "permission"] as const;

const PROVIDER_ID = "github-cloud";

interface Deps {
  log: (message: string) => void;
  /** Injected in tests. */
  connectApi?: (env: Readonly<Record<string, string>>) => Promise<CopilotTasksApi>;
  cache?: TaskCache;
}

export function createGitHubCloudProvider(deps: Deps): ProviderRegistration {
  const connectApi = deps.connectApi ?? ((env) => CopilotTasksApi.connect(env));
  const cache = deps.cache ?? fileTaskCache();
  return {
    id: PROVIDER_ID,
    label: "GitHub Copilot (cloud)",
    description: "GitHub Copilot cloud agent tasks: run in GitHub's sandbox, billed to your Copilot plan",
    icon: "icon.svg",
    async status() {
      try {
        await connectApi({});
        return { available: true };
      } catch (error) {
        return { available: false, diagnostic: errorMessage(error) };
      }
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES), deps.log, connectApi, cache);
    },
  };
}

function createConnection(
  capabilities: readonly string[],
  log: (message: string) => void,
  connectApi: (env: Readonly<Record<string, string>>) => Promise<CopilotTasksApi>,
  cache: TaskCache,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, CloudTaskSession>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };
  const fail = (requestId: string, error: unknown) =>
    emit({ type: "request.failed", requestId, error: { message: errorMessage(error) } });

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        try {
          const models = await loadModels(await connectApi({}));
          emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: { models, modes: MODES, defaultModel: DEFAULT_MODEL, defaultMode: DEFAULT_MODE },
          });
        } catch (error) {
          fail(input.requestId, error);
        }
        return;
      case "sessions":
        emit({ type: "sessions", requestId: input.requestId, sessions: [] });
        return;
      case "session.open":
        try {
          sessions.set(input.sessionId, await openSession(input, emit, log, connectApi, cache));
        } catch (error) {
          fail(input.requestId, error);
        }
        return;
      case "session.prompt":
        await requireSession(input.sessionId).prompt(input.prompt);
        return;
      case "session.interrupt":
        try {
          await requireSession(input.sessionId).interrupt();
          emit({ type: "request.completed", requestId: input.requestId });
        } catch (error) {
          fail(input.requestId, error);
        }
        return;
      case "session.configure":
        try {
          await requireSession(input.sessionId).configure(input.changes);
          emit({ type: "request.completed", requestId: input.requestId });
        } catch (error) {
          fail(input.requestId, error);
        }
        return;
      case "session.permission":
        await requireSession(input.sessionId).respondToPermission(input.permissionId, input.response);
        return;
      case "session.close":
        sessions.get(input.sessionId)?.stop();
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      default:
        if ("requestId" in input) fail(input.requestId, new Error(`Unsupported: ${input.type}`));
    }
  }

  function requireSession(sessionId: string): CloudTaskSession {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      queueMicrotask(() => {
        dispatch(input).catch((error) => log(`${input.type} failed: ${errorMessage(error)}`));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const session of sessions.values()) session.stop();
      sessions.clear();
      listeners.clear();
    },
  };
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  emit: (event: ProviderEvent) => void,
  log: (message: string) => void,
  connectApi: (env: Readonly<Record<string, string>>) => Promise<CopilotTasksApi>,
  cache: TaskCache,
): Promise<CloudTaskSession> {
  const { config } = input;
  const api = await connectApi(config.env);
  // An agent the link handler created names its task in providerOptions; a restored one in persistence.
  const taskId = persistedTaskId(input.persistence) ?? optionTaskId(config.providerOptions);
  const task = taskId ? await api.getTask(taskId) : null;
  // New agents start a task on their first prompt, on the workspace's repository.
  const repo = task ? null : await readRepo(config.cwd);
  const model = config.model ?? task?.sessions?.at(-1)?.model ?? DEFAULT_MODEL;
  const kind = taskKind(task);
  // Older agents saved mode "default"; a task's own kind decides what its mode can be.
  const mode =
    kind === "pull-request"
      ? PULL_REQUEST_MODE
      : config.mode && config.mode !== PULL_REQUEST_MODE && config.mode !== "default"
        ? config.mode
        : kind === "new" && config.mode === PULL_REQUEST_MODE
          ? PULL_REQUEST_MODE
          : DEFAULT_MODE;

  const models = await loadModels(api).catch(() => MODELS);
  const session = new CloudTaskSession({ api, paseoSessionId: input.sessionId, task, repo, model, mode, models, cache, emit, log });
  emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: CAPABILITIES,
    restoration: "core",
    ...(task ? { persistence: persistenceFor(task.id) } : {}),
    title: config.title ?? task?.name,
    cwd: config.cwd,
  });
  emit({ type: "session.config", sessionId: input.sessionId, config: configState(model, mode, models, kind) });
  // A task opened from a link has no Paseo history yet. Paseo drops timeline items a new agent emits
  // while opening, so its history arrives through the first poll instead.
  if (task) await session.attach(input.persistence ? { reopen: { replay: input.history === "replay" } } : { catchUp: true });
  emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
  return session;
}

async function loadModels(api: CopilotTasksApi): Promise<ProviderModel[]> {
  const models = await api.models();
  return models.map((model) => ({ id: model.id, label: model.name, ...(model.id === DEFAULT_MODEL ? { isDefault: true } : {}) }));
}

export function persistenceFor(taskId: string): ProviderPersistence {
  return { version: 1, data: { taskId } };
}

function persistedTaskId(persistence: ProviderPersistence | undefined): string | null {
  const data = persistence?.data;
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data.taskId === "string") return data.taskId;
  return null;
}

function optionTaskId(options: Readonly<Record<string, unknown>> | undefined): string | null {
  return typeof options?.taskId === "string" && options.taskId ? options.taskId : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
