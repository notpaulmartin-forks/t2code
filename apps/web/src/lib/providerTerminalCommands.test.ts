import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vitest";

import { buildProviderLaunchCommand, buildProviderResumeCommand } from "./providerTerminalCommands";

describe("providerTerminalCommands", () => {
  it("includes the opencode session id when launching an explicitly created session", () => {
    expect(
      buildProviderLaunchCommand({
        provider: "opencode",
        settings: DEFAULT_UNIFIED_SETTINGS,
        sessionId: "ses_123",
      }),
    ).toBe("exec 'opencode' --session 'ses_123'");
  });

  it("uses the opencode session flag for resume commands", () => {
    expect(
      buildProviderResumeCommand({
        provider: "opencode",
        settings: DEFAULT_UNIFIED_SETTINGS,
        sessionId: "ses_123",
      }),
    ).toBe("exec 'opencode' --session 'ses_123'");
  });
});
