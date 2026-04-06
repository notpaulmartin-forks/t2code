import { type ProviderKind } from "@t3tools/contracts";
import { type UnifiedSettings } from "@t3tools/contracts/settings";
import { DEFAULT_THREAD_TERMINAL_ID, type Thread } from "../types";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { useEffect, useMemo, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useSettings } from "../hooks/useSettings";
import { buildProviderResumeCommand, providerTerminalLabel } from "../lib/providerTerminalCommands";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useProjectById, useThreadById } from "../storeSelectors";
import {
  type ThreadTerminalResumeBinding,
  type ThreadTerminalStartupRequest,
} from "../terminalStateStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { SidebarTrigger } from "./ui/sidebar";
import { ThreadTerminalSurface } from "./ThreadTerminalSurface";
import { toastManager } from "./ui/toast";

interface ThreadTerminalViewProps {
  threadId: Thread["id"];
}

const launchedProviderThreadIdsThisSession = new Set<string>();
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
  const launchCommandRef = useRef<string | null>(null);
  const startupSessionResolveAttemptRef = useRef<string | null>(null);
  const resumeBindingResolveAttemptRef = useRef<string | null>(null);
  const autoLaunchConsumedRef = useRef(false);

  useEffect(() => {
    setTerminalOpen(threadId, true);
  }, [setTerminalOpen, threadId]);

  useEffect(() => {
    autoLaunchConsumedRef.current = false;
  }, [threadId]);

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
      threadProvider !== "codex" ||
      startupRequest !== null ||
      effectiveResumeBinding !== null
    ) {
      return;
    }

    if (launchedProviderThreadIdsThisSession.has(threadId)) {
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
    startupRequest,
    threadId,
    threadProvider,
  ]);

  useEffect(() => {
    if (!cwd) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      return;
    }

    const { commandToRun, shouldFreshResumeTerminal } = resolveProviderTerminalStartup({
      startupRequest,
      resumeBinding: effectiveResumeBinding,
      settings,
      launchedInSession: launchedProviderThreadIdsThisSession.has(threadId),
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

      launchedProviderThreadIdsThisSession.add(threadId);

      if (startupRequest?.provider === "claudeAgent" && startupRequest.sessionId) {
        setTerminalResumeBinding(threadId, {
          provider: startupRequest.provider,
          sessionId: startupRequest.sessionId,
        });
        return;
      }

      if (startupRequest?.provider !== "codex") {
        return;
      }

      const resolutionKey = `${threadId}:${startupRequest.startedAt}`;
      if (startupSessionResolveAttemptRef.current === resolutionKey) {
        return;
      }
      startupSessionResolveAttemptRef.current = resolutionKey;
      try {
        for (let attempt = 0; attempt < 8; attempt += 1) {
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
  ]);

  if (!project) {
    return null;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="border-b border-border px-3 py-2 md:px-4">
        <div className="flex items-center gap-3">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {serverThread?.title ?? `${providerLabel} thread`}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {project.name} - {providerLabel}
            </p>
          </div>
        </div>
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
