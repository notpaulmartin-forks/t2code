import {
  type KeybindingCommand,
  type ProjectId,
  type ProjectScript,
  type ProviderKind,
} from "@t3tools/contracts";
import { type UnifiedSettings } from "@t3tools/contracts/settings";
import { DEFAULT_THREAD_TERMINAL_ID, type Thread } from "../types";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { useComposerDraftStore } from "../composerDraftStore";
import { useSettings } from "../hooks/useSettings";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { buildProviderResumeCommand, providerTerminalLabel } from "../lib/providerTerminalCommands";
import { readNativeApi } from "../nativeApi";
import { useWsConnectionStatus } from "../rpc/wsConnectionState";
import { useStore } from "../store";
import { useProjectById, useThreadById } from "../storeSelectors";
import {
  type ThreadTerminalResumeBinding,
  type ThreadTerminalStartupRequest,
} from "../terminalStateStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { ThreadTerminalSurface } from "./ThreadTerminalSurface";
import { toastManager } from "./ui/toast";
import { ChatHeader } from "./chat/ChatHeader";
import { useServerAvailableEditors, useServerKeybindings } from "~/rpc/serverState";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { shortcutLabelForCommand } from "../keybindings";
import { cn, newCommandId } from "~/lib/utils";
import { isElectron } from "../env";
import { commandForProjectScript, nextProjectScriptId } from "../projectScripts";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
} from "./ChatView.logic";

interface ThreadTerminalViewProps {
  threadId: Thread["id"];
}

// Maps threadId → the WS connectedAt timestamp when it was launched, so that a server
// reconnect (new connectedAt) correctly clears the "already launched" guard.
const launchedProviderThreadIdsByConnectionId = new Map<string, string>();
const DEFAULT_PROVIDER_TERMINAL_COLS = 120;
const DEFAULT_PROVIDER_TERMINAL_ROWS = 30;

export function resolveProviderTerminalStartup(input: {
  startupRequest: ThreadTerminalStartupRequest | null;
  resumeBinding: ThreadTerminalResumeBinding | null;
  settings: UnifiedSettings;
  launchedInSession: boolean;
}): {
  commandToRun: string | null;
  shouldFreshResumeTerminal: boolean;
} {
  if (input.startupRequest !== null) {
    return {
      commandToRun: input.startupRequest.command,
      shouldFreshResumeTerminal: false,
    };
  }

  if (input.resumeBinding === null || input.launchedInSession) {
    return {
      commandToRun: null,
      shouldFreshResumeTerminal: false,
    };
  }

  return {
    commandToRun: buildProviderResumeCommand({
      provider: input.resumeBinding.provider,
      settings: input.settings,
      sessionId: input.resumeBinding.sessionId,
    }),
    shouldFreshResumeTerminal: true,
  };
}

export function resolveTerminalResumeBinding(input: {
  threadProvider: ProviderKind | null;
  resumeBinding: ThreadTerminalResumeBinding | null;
  codexThreadId: string | null | undefined;
}): ThreadTerminalResumeBinding | null {
  if (
    input.threadProvider === "codex" &&
    input.resumeBinding?.provider === "codex" &&
    input.codexThreadId &&
    input.resumeBinding.sessionId === input.codexThreadId
  ) {
    return null;
  }

  return input.resumeBinding;
}

function providerLabelForThread(
  thread: Thread | undefined,
  draftProvider: ProviderKind | null,
): string {
  return providerTerminalLabel(thread?.modelSelection.provider ?? draftProvider);
}

function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export default function ThreadTerminalView({ threadId }: ThreadTerminalViewProps) {
  const serverThread = useThreadById(threadId);
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const draftComposer = useComposerDraftStore((store) => store.draftsByThreadId[threadId] ?? null);
  const project = useProjectById(serverThread?.projectId ?? draftThread?.projectId);
  const settings = useSettings();
  const wsConnectedAt = useWsConnectionStatus().connectedAt;
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const startupRequest = useTerminalStateStore(
    (state) => state.terminalStartupRequestByThreadId[threadId] ?? null,
  );
  const resumeBinding = useTerminalStateStore(
    (state) => state.terminalResumeBindingByThreadId[threadId] ?? null,
  );
  const ensureTerminal = useTerminalStateStore((state) => state.ensureTerminal);
  const setTerminalOpen = useTerminalStateStore((state) => state.setTerminalOpen);
  const setTerminalLaunchContext = useTerminalStateStore((state) => state.setTerminalLaunchContext);
  const clearTerminalStartupRequest = useTerminalStateStore(
    (state) => state.clearTerminalStartupRequest,
  );
  const clearTerminalResumeBinding = useTerminalStateStore(
    (state) => state.clearTerminalResumeBinding,
  );
  const setTerminalResumeBinding = useTerminalStateStore((state) => state.setTerminalResumeBinding);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const navigate = useNavigate();
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const diffOpen = diffSearch.diff === "1";
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const cwd = useMemo(
    () =>
      project
        ? projectScriptCwd({
            project: { cwd: project.cwd },
            worktreePath,
          })
        : null,
    [project, worktreePath],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.cwd },
            worktreePath,
          })
        : {},
    [project, worktreePath],
  );
  const draftProvider = useMemo(() => {
    const activeProvider = draftComposer?.activeProvider;
    if (activeProvider && draftComposer?.modelSelectionByProvider[activeProvider]) {
      return activeProvider;
    }
    return Object.values(draftComposer?.modelSelectionByProvider ?? {})[0]?.provider ?? null;
  }, [draftComposer]);
  const threadProvider = serverThread?.modelSelection.provider ?? draftProvider;
  const effectiveResumeBinding = useMemo<ThreadTerminalResumeBinding | null>(
    () =>
      resolveTerminalResumeBinding({
        threadProvider,
        resumeBinding,
        codexThreadId: serverThread?.codexThreadId,
      }),
    [resumeBinding, serverThread?.codexThreadId, threadProvider],
  );
  const providerLabel = providerLabelForThread(serverThread, draftProvider);
  const gitStatusQuery = useQuery(gitStatusQueryOptions(cwd));
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle"),
    [keybindings],
  );
  const onToggleDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  }, [diffOpen, navigate, threadId]);

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });
      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
      }
    },
    [],
  );

  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!project) return;
      const nextId = nextProjectScriptId(
        input.name,
        project.scripts.map((s) => s.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...project.scripts.map((s) =>
              s.runOnWorktreeCreate ? { ...s, runOnWorktreeCreate: false } : s,
            ),
            nextScript,
          ]
        : [...project.scripts, nextScript];
      await persistProjectScripts({
        projectId: project.id,
        projectCwd: project.cwd,
        previousScripts: project.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [project, persistProjectScripts],
  );

  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!project) return;
      const existingScript = project.scripts.find((script) => script.id === scriptId);
      if (!existingScript) throw new Error("Script not found.");
      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = project.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );
      await persistProjectScripts({
        projectId: project.id,
        projectCwd: project.cwd,
        previousScripts: project.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [project, persistProjectScripts],
  );

  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!project) return;
      const nextScripts = project.scripts.filter((s) => s.id !== scriptId);
      const deletedName = project.scripts.find((s) => s.id === scriptId)?.name;
      try {
        await persistProjectScripts({
          projectId: project.id,
          projectCwd: project.cwd,
          previousScripts: project.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
      } catch {
        toastManager.add({
          type: "error",
          title: `Failed to delete script${deletedName ? ` "${deletedName}"` : ""}`,
        });
      }
    },
    [project, persistProjectScripts],
  );

  const runProjectScript = useCallback(
    async (script: ProjectScript) => {
      const api = readNativeApi();
      if (!api || !project || !cwd) return;
      setLastInvokedScriptByProjectId((current) => {
        if (current[project.id] === script.id) return current;
        return { ...current, [project.id]: script.id };
      });
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const targetTerminalId = isBaseTerminalBusy
        ? `terminal-${crypto.randomUUID()}`
        : baseTerminalId;
      if (isBaseTerminalBusy) {
        storeNewTerminal(threadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(threadId, targetTerminalId);
      }
      const scriptRuntimeEnv = projectScriptRuntimeEnv({
        project: { cwd: project.cwd },
        worktreePath,
      });
      try {
        await api.terminal.open({
          threadId,
          terminalId: targetTerminalId,
          cwd,
          ...(worktreePath !== null ? { worktreePath } : {}),
          env: scriptRuntimeEnv,
        });
        await api.terminal.write({
          threadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Failed to run script "${script.name}"`,
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [
      project,
      cwd,
      worktreePath,
      threadId,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
    ],
  );

  const launchCommandRef = useRef<string | null>(null);
  const startupSessionResolveAttemptRef = useRef<string | null>(null);
  const resumeBindingResolveAttemptRef = useRef<string | null>(null);
  const autoLaunchConsumedRef = useRef(false);

  useEffect(() => {
    setTerminalOpen(threadId, true);
  }, [setTerminalOpen, threadId]);

  useEffect(() => {
    autoLaunchConsumedRef.current = false;
    launchCommandRef.current = null;
    resumeBindingResolveAttemptRef.current = null;
    startupSessionResolveAttemptRef.current = null;
  }, [threadId, wsConnectedAt]);

  useEffect(() => {
    if (
      threadProvider !== "codex" ||
      resumeBinding?.provider !== "codex" ||
      !serverThread?.codexThreadId ||
      resumeBinding.sessionId !== serverThread.codexThreadId
    ) {
      return;
    }

    clearTerminalResumeBinding(threadId);
  }, [
    clearTerminalResumeBinding,
    resumeBinding,
    serverThread?.codexThreadId,
    threadId,
    threadProvider,
  ]);

  useEffect(() => {
    if (
      !cwd ||
      (threadProvider !== "codex" && threadProvider !== "opencode") ||
      startupRequest !== null ||
      effectiveResumeBinding !== null
    ) {
      return;
    }

    if (wsConnectedAt && launchedProviderThreadIdsByConnectionId.get(threadId) === wsConnectedAt) {
      return;
    }

    const startedAt = serverThread?.createdAt ?? draftThread?.createdAt;
    if (!startedAt) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      return;
    }

    const codexThreadId = serverThread?.codexThreadId ?? null;
    const resolutionKey = `${threadId}:${startedAt}:${codexThreadId ?? ""}`;
    if (resumeBindingResolveAttemptRef.current === resolutionKey) {
      return;
    }
    resumeBindingResolveAttemptRef.current = resolutionKey;

    void api.server
      .resolveProviderSession({
        provider: threadProvider,
        cwd,
        startedAt,
        ...(settings.providers.codex.homePath.trim().length > 0
          ? { codexHomePath: settings.providers.codex.homePath.trim() }
          : {}),
        ...(threadProvider === "opencode" &&
        settings.providers.opencode.binaryPath.trim().length > 0
          ? { openCodeBinaryPath: settings.providers.opencode.binaryPath.trim() }
          : {}),
        ...(codexThreadId ? { excludeSessionId: codexThreadId } : {}),
      })
      .then((result) => {
        if (!result.sessionId) {
          return;
        }
        setTerminalResumeBinding(threadId, {
          provider: threadProvider,
          sessionId: result.sessionId,
        });
      })
      .catch(() => undefined);
  }, [
    cwd,
    draftThread?.createdAt,
    effectiveResumeBinding,
    serverThread?.codexThreadId,
    serverThread?.createdAt,
    setTerminalResumeBinding,
    settings.providers.codex.homePath,
    settings.providers.opencode.binaryPath,
    startupRequest,
    threadId,
    threadProvider,
    wsConnectedAt,
  ]);

  useEffect(() => {
    if (!cwd) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      return;
    }

    const launchedInSession =
      wsConnectedAt !== null &&
      launchedProviderThreadIdsByConnectionId.get(threadId) === wsConnectedAt;
    const { commandToRun, shouldFreshResumeTerminal } = resolveProviderTerminalStartup({
      startupRequest,
      resumeBinding: effectiveResumeBinding,
      settings,
      launchedInSession,
    });
    if (!commandToRun) {
      return;
    }
    if (autoLaunchConsumedRef.current) {
      return;
    }
    if (launchCommandRef.current === commandToRun) {
      return;
    }

    const terminalId = terminalState.activeTerminalId || DEFAULT_THREAD_TERMINAL_ID;
    autoLaunchConsumedRef.current = true;
    launchCommandRef.current = commandToRun;
    ensureTerminal(threadId, terminalId, { active: true, open: true });

    const runStartupCommand = async () => {
      const terminalOpenInput = {
        threadId,
        terminalId,
        cwd,
        ...(worktreePath !== null ? { worktreePath } : {}),
        env: runtimeEnv,
      };

      await (
        shouldFreshResumeTerminal
          ? api.terminal.restart({
              ...terminalOpenInput,
              cols: DEFAULT_PROVIDER_TERMINAL_COLS,
              rows: DEFAULT_PROVIDER_TERMINAL_ROWS,
            })
          : api.terminal.open(terminalOpenInput)
      ).then(() => {
        setTerminalLaunchContext(threadId, { cwd, worktreePath });
        return api.terminal.write({
          threadId,
          terminalId,
          data: `${commandToRun}\r`,
        });
      });

      if (wsConnectedAt) {
        launchedProviderThreadIdsByConnectionId.set(threadId, wsConnectedAt);
      }

      if (
        startupRequest?.sessionId &&
        (startupRequest.provider === "claudeAgent" || startupRequest.provider === "opencode")
      ) {
        setTerminalResumeBinding(threadId, {
          provider: startupRequest.provider,
          sessionId: startupRequest.sessionId,
        });
        return;
      }

      if (startupRequest?.provider !== "codex" && startupRequest?.provider !== "opencode") {
        return;
      }

      const resolutionKey = `${threadId}:${startupRequest.startedAt}`;
      if (startupSessionResolveAttemptRef.current === resolutionKey) {
        return;
      }
      startupSessionResolveAttemptRef.current = resolutionKey;
      try {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const currentCodexThreadId =
            useStore.getState().threads.find((t) => t.id === threadId)?.codexThreadId ?? null;
          const result = await api.server.resolveProviderSession({
            provider: startupRequest.provider,
            cwd,
            startedAt: startupRequest.startedAt,
            ...(startupRequest.provider === "codex" &&
            settings.providers.codex.homePath.trim().length > 0
              ? { codexHomePath: settings.providers.codex.homePath.trim() }
              : {}),
            ...(startupRequest.provider === "opencode" &&
            settings.providers.opencode.binaryPath.trim().length > 0
              ? { openCodeBinaryPath: settings.providers.opencode.binaryPath.trim() }
              : {}),
            ...(currentCodexThreadId ? { excludeSessionId: currentCodexThreadId } : {}),
          });
          if (result.sessionId) {
            setTerminalResumeBinding(threadId, {
              provider: startupRequest.provider,
              sessionId: result.sessionId,
            });
            return;
          }
          await waitForMs(750);
        }
      } finally {
        startupSessionResolveAttemptRef.current = null;
      }
    };

    void runStartupCommand()
      .catch((error) => {
        autoLaunchConsumedRef.current = false;
        toastManager.add({
          type: "error",
          title: `Failed to launch ${providerLabel}`,
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      })
      .finally(() => {
        if (startupRequest !== null) {
          clearTerminalStartupRequest(threadId);
        }
        launchCommandRef.current = null;
      });
  }, [
    clearTerminalStartupRequest,
    cwd,
    ensureTerminal,
    providerLabel,
    effectiveResumeBinding,
    runtimeEnv,
    setTerminalResumeBinding,
    settings,
    setTerminalLaunchContext,
    startupRequest,
    terminalState.activeTerminalId,
    threadId,
    worktreePath,
    wsConnectedAt,
  ]);

  if (!project) {
    return null;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
        )}
      >
        <ChatHeader
          activeThreadId={threadId}
          activeThreadTitle={serverThread?.title ?? `${providerLabel} thread`}
          activeProjectName={project.name}
          isGitRepo={isGitRepo}
          openInCwd={cwd}
          activeProjectScripts={project.scripts}
          preferredScriptId={lastInvokedScriptByProjectId[project.id] ?? null}
          keybindings={keybindings}
          availableEditors={availableEditors}
          terminalAvailable={false}
          terminalOpen={false}
          terminalToggleShortcutLabel={terminalToggleShortcutLabel}
          diffToggleShortcutLabel={diffPanelShortcutLabel}
          gitCwd={cwd}
          diffOpen={diffOpen}
          onRunProjectScript={(script) => {
            void runProjectScript(script);
          }}
          onAddProjectScript={saveProjectScript}
          onUpdateProjectScript={updateProjectScript}
          onDeleteProjectScript={deleteProjectScript}
          onToggleTerminal={() => undefined}
          onToggleDiff={onToggleDiff}
        />
      </header>
      <div className="min-h-0 flex-1 p-3 md:p-4">
        <ThreadTerminalSurface
          threadId={threadId}
          visible
          layout="panel"
          launchContext={cwd ? { cwd, worktreePath } : null}
          focusRequestId={1}
          onAddTerminalContext={() => undefined}
        />
      </div>
    </div>
  );
}
