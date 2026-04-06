import { DEFAULT_THREAD_TERMINAL_ID, type Thread } from "../types";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { useEffect, useMemo, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useProjectById, useThreadById } from "../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { SidebarTrigger } from "./ui/sidebar";
import { ThreadTerminalSurface } from "./ThreadTerminalSurface";
import { toastManager } from "./ui/toast";

interface ThreadTerminalViewProps {
  threadId: Thread["id"];
}

function providerLabelForThread(thread: Thread | undefined, draftProvider: string | null): string {
  const provider = thread?.modelSelection.provider ?? draftProvider;
  if (provider === "claudeAgent") {
    return "Claude Code";
  }
  if (provider === "codex") {
    return "Codex";
  }
  return "Terminal";
}

export default function ThreadTerminalView({ threadId }: ThreadTerminalViewProps) {
  const serverThread = useThreadById(threadId);
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const draftComposer = useComposerDraftStore((store) => store.draftsByThreadId[threadId] ?? null);
  const project = useProjectById(serverThread?.projectId ?? draftThread?.projectId);
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const startupRequest = useTerminalStateStore(
    (state) => state.terminalStartupRequestByThreadId[threadId] ?? null,
  );
  const ensureTerminal = useTerminalStateStore((state) => state.ensureTerminal);
  const setTerminalOpen = useTerminalStateStore((state) => state.setTerminalOpen);
  const setTerminalLaunchContext = useTerminalStateStore((state) => state.setTerminalLaunchContext);
  const clearTerminalStartupRequest = useTerminalStateStore(
    (state) => state.clearTerminalStartupRequest,
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
  const providerLabel = providerLabelForThread(serverThread, draftProvider);
  const launchCommandRef = useRef<string | null>(null);

  useEffect(() => {
    setTerminalOpen(threadId, true);
  }, [setTerminalOpen, threadId]);

  useEffect(() => {
    if (!startupRequest || !cwd) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      return;
    }

    if (launchCommandRef.current === startupRequest.command) {
      return;
    }

    const terminalId = terminalState.activeTerminalId || DEFAULT_THREAD_TERMINAL_ID;
    launchCommandRef.current = startupRequest.command;
    ensureTerminal(threadId, terminalId, { active: true, open: true });
    setTerminalLaunchContext(threadId, { cwd, worktreePath });

    void api.terminal
      .open({
        threadId,
        terminalId,
        cwd,
        ...(worktreePath !== null ? { worktreePath } : {}),
        env: runtimeEnv,
      })
      .then(() =>
        api.terminal.write({
          threadId,
          terminalId,
          data: `${startupRequest.command}\r`,
        }),
      )
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: `Failed to launch ${providerLabel}`,
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      })
      .finally(() => {
        clearTerminalStartupRequest(threadId);
        launchCommandRef.current = null;
      });
  }, [
    clearTerminalStartupRequest,
    cwd,
    ensureTerminal,
    providerLabel,
    runtimeEnv,
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
