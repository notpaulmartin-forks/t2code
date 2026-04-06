import { type ProjectId, type ProviderKind } from "@t3tools/contracts";
import { create } from "zustand";

import { type DraftThreadEnvMode } from "./composerDraftStore";

export interface NewThreadRequest {
  projectId: ProjectId;
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
}

interface NewThreadDialogState {
  open: boolean;
  request: NewThreadRequest | null;
  selectedProvider: ProviderKind | null;
  setOpen: (open: boolean) => void;
  openDialog: (request: NewThreadRequest) => void;
  closeDialog: () => void;
  setSelectedProvider: (provider: ProviderKind | null) => void;
}

export const useNewThreadDialogStore = create<NewThreadDialogState>()((set) => ({
  open: false,
  request: null,
  selectedProvider: null,
  setOpen: (open) =>
    set((state) =>
      open
        ? { open: true }
        : {
            open: false,
            request: null,
            selectedProvider: state.selectedProvider,
          },
    ),
  openDialog: (request) =>
    set((state) => ({
      open: true,
      request,
      selectedProvider: state.selectedProvider,
    })),
  closeDialog: () =>
    set((state) => ({
      open: false,
      request: null,
      selectedProvider: state.selectedProvider,
    })),
  setSelectedProvider: (provider) => set({ selectedProvider: provider }),
}));
