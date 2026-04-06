import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vitest";

import { resolveProviderTerminalStartup, resolveTerminalResumeBinding } from "./ThreadTerminalView";

describe("resolveProviderTerminalStartup", () => {
  it("returns startup requests directly", () => {
    expect(
      resolveProviderTerminalStartup({
        startupRequest: {
          provider: "claudeAgent",
          startedAt: "2026-04-06T12:00:00.000Z",
          sessionId: "thread-1",
          command: "claude --session-id 'thread-1'",
        },
        resumeBinding: {
          provider: "claudeAgent",
          sessionId: "session-1",
        },
        settings: DEFAULT_UNIFIED_SETTINGS,
        launchedInSession: true,
      }),
    ).toEqual({
      commandToRun: "claude --session-id 'thread-1'",
      shouldFreshResumeTerminal: false,
    });
  });

  it("auto-resumes unopened provider threads", () => {
    expect(
      resolveProviderTerminalStartup({
        startupRequest: null,
        resumeBinding: {
          provider: "claudeAgent",
          sessionId: "18d63910-2eea-4d1f-9374-e4fda40442ed",
        },
        settings: DEFAULT_UNIFIED_SETTINGS,
        launchedInSession: false,
      }),
    ).toEqual({
      commandToRun: "'claude' --resume '18d63910-2eea-4d1f-9374-e4fda40442ed'",
      shouldFreshResumeTerminal: true,
    });
  });

  it("does not re-send resume commands after the thread was launched in this session", () => {
    expect(
      resolveProviderTerminalStartup({
        startupRequest: null,
        resumeBinding: {
          provider: "claudeAgent",
          sessionId: "18d63910-2eea-4d1f-9374-e4fda40442ed",
        },
        settings: DEFAULT_UNIFIED_SETTINGS,
        launchedInSession: true,
      }),
    ).toEqual({ commandToRun: null, shouldFreshResumeTerminal: false });
  });
});

describe("resolveTerminalResumeBinding", () => {
  it("ignores stale codex bindings that match the provider thread id", () => {
    expect(
      resolveTerminalResumeBinding({
        threadProvider: "codex",
        resumeBinding: {
          provider: "codex",
          sessionId: "provider-thread-1",
        },
        codexThreadId: "provider-thread-1",
      }),
    ).toBeNull();
  });

  it("keeps codex bindings that differ from the provider thread id", () => {
    expect(
      resolveTerminalResumeBinding({
        threadProvider: "codex",
        resumeBinding: {
          provider: "codex",
          sessionId: "cli-session-1",
        },
        codexThreadId: "provider-thread-1",
      }),
    ).toEqual({
      provider: "codex",
      sessionId: "cli-session-1",
    });
  });
});
