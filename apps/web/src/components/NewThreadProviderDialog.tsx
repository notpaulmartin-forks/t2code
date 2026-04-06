import {
  type ModelSelection,
  type ProviderKind,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ClaudeAI, OpenAI } from "./Icons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { useNewThreadDialogStore } from "../newThreadDialogStore";
import { useServerProviders } from "../rpc/serverState";
import { useSettings } from "../hooks/useSettings";
import { getProviderModels } from "../providerModels";
import { resolveAppModelSelection } from "../modelSelection";
import { getComposerProviderState } from "./chat/composerProviderRegistry";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useComposerDraftStore } from "../composerDraftStore";
import { DEFAULT_THREAD_TERMINAL_ID } from "../types";
import { readNativeApi } from "../nativeApi";
import { newCommandId } from "../lib/utils";
import { useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import { cn } from "../lib/utils";
import { type UnifiedSettings } from "@t3tools/contracts/settings";

const PROVIDER_OPTIONS: ReadonlyArray<{
  provider: ProviderKind;
  label: string;
  subtitle: string;
  Icon: typeof OpenAI;
}> = [
  {
    provider: "codex",
    label: "Codex",
    subtitle: "Open a Codex terminal in the selected thread.",
    Icon: OpenAI,
  },
  {
    provider: "claudeAgent",
    label: "Claude Code",
    subtitle: "Open a Claude Code terminal in the selected thread.",
    Icon: ClaudeAI,
  },
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildProviderCommand(provider: ProviderKind, settings: UnifiedSettings): string {
  if (provider === "codex") {
    const binaryPath = settings.providers.codex.binaryPath || "codex";
    const homePath = settings.providers.codex.homePath.trim();
    if (homePath.length > 0) {
      return `CODEX_HOME=${shellQuote(homePath)} ${shellQuote(binaryPath)}`;
    }
    return shellQuote(binaryPath);
  }

  return shellQuote(settings.providers.claudeAgent.binaryPath || "claude");
}

function resolveThreadModelSelection(
  provider: ProviderKind,
  settings: UnifiedSettings,
  serverProviders: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selectedModel =
    settings.textGenerationModelSelection.provider === provider
      ? settings.textGenerationModelSelection.model
      : null;
  const model = resolveAppModelSelection(provider, settings, serverProviders, selectedModel);
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider,
    model,
    models: getProviderModels(serverProviders, provider),
    prompt: "",
    modelOptions: {
      [provider]:
        settings.textGenerationModelSelection.provider === provider
          ? settings.textGenerationModelSelection.options
          : undefined,
    },
  });

  return {
    provider,
    model,
    ...(modelOptionsForDispatch ? { options: modelOptionsForDispatch } : {}),
  };
}

function buildThreadTitle(provider: ProviderKind): string {
  return provider === "codex" ? "Codex thread" : "Claude Code thread";
}

function providerDisabledReason(
  provider: ProviderKind,
  settings: UnifiedSettings,
  serverProviders: ReadonlyArray<ServerProvider>,
): string | null {
  const providerSettings = settings.providers[provider];
  if (!providerSettings.enabled) {
    return `${PROVIDER_DISPLAY_NAMES[provider]} is disabled in settings.`;
  }

  const serverProvider = serverProviders.find((candidate) => candidate.provider === provider);
  if (serverProvider?.installed === false) {
    return serverProvider.message ?? `${PROVIDER_DISPLAY_NAMES[provider]} is not installed.`;
  }
  if (serverProvider?.status === "error") {
    return serverProvider.message ?? `${PROVIDER_DISPLAY_NAMES[provider]} is unavailable.`;
  }

  return null;
}

export function NewThreadProviderDialog() {
  const open = useNewThreadDialogStore((state) => state.open);
  const request = useNewThreadDialogStore((state) => state.request);
  const selectedProvider = useNewThreadDialogStore((state) => state.selectedProvider);
  const closeDialog = useNewThreadDialogStore((state) => state.closeDialog);
  const setOpen = useNewThreadDialogStore((state) => state.setOpen);
  const setSelectedProvider = useNewThreadDialogStore((state) => state.setSelectedProvider);
  const settings = useSettings();
  const serverProviders = useServerProviders();
  const { handleNewThread } = useHandleNewThread();
  const setModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const setStickyModelSelection = useComposerDraftStore((state) => state.setStickyModelSelection);
  const ensureTerminal = useTerminalStateStore((state) => state.ensureTerminal);
  const setTerminalStartupRequest = useTerminalStateStore(
    (state) => state.setTerminalStartupRequest,
  );
  const [submittingProvider, setSubmittingProvider] = useState<ProviderKind | null>(null);

  const firstEnabledProvider = useMemo(() => {
    return (
      PROVIDER_OPTIONS.find(
        (option) => providerDisabledReason(option.provider, settings, serverProviders) === null,
      )?.provider ?? "codex"
    );
  }, [serverProviders, settings]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const activeProvider = selectedProvider ?? firstEnabledProvider;
    if (activeProvider !== selectedProvider) {
      setSelectedProvider(activeProvider);
    }
  }, [firstEnabledProvider, open, selectedProvider, setSelectedProvider]);

  const createThread = useCallback(
    async (provider: ProviderKind) => {
      if (!request) {
        return;
      }

      const disabledReason = providerDisabledReason(provider, settings, serverProviders);
      if (disabledReason) {
        toastManager.add({
          type: "error",
          title: `Could not start ${PROVIDER_DISPLAY_NAMES[provider]}`,
          description: disabledReason,
        });
        return;
      }

      const api = readNativeApi();
      if (!api) {
        return;
      }

      setSubmittingProvider(provider);
      const modelSelection = resolveThreadModelSelection(provider, settings, serverProviders);

      try {
        const threadId = await handleNewThread(request.projectId, {
          ...(request.branch !== undefined ? { branch: request.branch } : {}),
          ...(request.worktreePath !== undefined ? { worktreePath: request.worktreePath } : {}),
          ...(request.envMode !== undefined ? { envMode: request.envMode } : {}),
          reuseExistingDraft: false,
        });

        setModelSelection(threadId, modelSelection);
        setStickyModelSelection(modelSelection);
        ensureTerminal(threadId, DEFAULT_THREAD_TERMINAL_ID, { active: true, open: true });
        setTerminalStartupRequest(threadId, {
          command: buildProviderCommand(provider, settings),
        });

        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: request.projectId,
          title: buildThreadTitle(provider),
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: request.branch ?? null,
          worktreePath: request.worktreePath ?? null,
          createdAt: new Date().toISOString(),
        });

        closeDialog();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to create thread",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      } finally {
        setSubmittingProvider(null);
      }
    },
    [
      closeDialog,
      ensureTerminal,
      handleNewThread,
      request,
      serverProviders,
      setModelSelection,
      setStickyModelSelection,
      setTerminalStartupRequest,
      settings,
    ],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose a provider</DialogTitle>
          <DialogDescription>
            New threads now open directly into a provider terminal. Pick which CLI should start in
            the main terminal for this thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-3 sm:grid-cols-2">
          {PROVIDER_OPTIONS.map(({ provider, label, subtitle, Icon }) => {
            const disabledReason = providerDisabledReason(provider, settings, serverProviders);
            const isSelected = selectedProvider === provider;
            const isSubmitting = submittingProvider === provider;

            return (
              <button
                key={provider}
                type="button"
                disabled={disabledReason !== null || submittingProvider !== null}
                onClick={() => {
                  setSelectedProvider(provider);
                  void createThread(provider);
                }}
                className={cn(
                  "flex min-h-36 flex-col rounded-2xl border px-5 py-4 text-left transition-colors",
                  disabledReason === null
                    ? "border-border bg-card hover:border-foreground/25 hover:bg-accent/30"
                    : "cursor-not-allowed border-border/70 bg-muted/30 opacity-60",
                  isSelected && disabledReason === null && "border-foreground/25 bg-accent/30",
                )}
              >
                <div className="flex items-center gap-3">
                  <Icon
                    className={cn(
                      "size-5 shrink-0",
                      provider === "claudeAgent" ? "text-[#d97757]" : "text-foreground",
                    )}
                  />
                  <span className="text-sm font-medium text-foreground">{label}</span>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{subtitle}</p>
                <p className="mt-auto pt-5 text-xs text-muted-foreground">
                  {isSubmitting
                    ? "Starting terminal..."
                    : (disabledReason ?? "Create the thread and launch the CLI immediately.")}
                </p>
              </button>
            );
          })}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog} disabled={submittingProvider !== null}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
