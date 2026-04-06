import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@t3tools/contracts";
import { type UnifiedSettings } from "@t3tools/contracts/settings";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function binaryPathForProvider(provider: ProviderKind, settings: UnifiedSettings): string {
  if (provider === "codex") {
    return settings.providers.codex.binaryPath || "codex";
  }
  return settings.providers.claudeAgent.binaryPath || "claude";
}

function commandPrefixForProvider(provider: ProviderKind, settings: UnifiedSettings): string {
  const binaryPath = binaryPathForProvider(provider, settings);
  if (provider !== "codex") {
    return shellQuote(binaryPath);
  }

  const homePath = settings.providers.codex.homePath.trim();
  if (homePath.length === 0) {
    return shellQuote(binaryPath);
  }

  return `CODEX_HOME=${shellQuote(homePath)} ${shellQuote(binaryPath)}`;
}

export function buildProviderLaunchCommand(input: {
  provider: ProviderKind;
  settings: UnifiedSettings;
  sessionId?: string | null;
  title?: string | null;
}): string {
  const commandPrefix = commandPrefixForProvider(input.provider, input.settings);

  if (input.provider === "claudeAgent") {
    const parts = [commandPrefix];
    if (input.sessionId && input.sessionId.trim().length > 0) {
      parts.push("--session-id", shellQuote(input.sessionId));
    }
    if (input.title && input.title.trim().length > 0) {
      parts.push("-n", shellQuote(input.title));
    }
    return parts.join(" ");
  }

  return commandPrefix;
}

export function buildProviderResumeCommand(input: {
  provider: ProviderKind;
  settings: UnifiedSettings;
  sessionId: string;
}): string {
  const commandPrefix = commandPrefixForProvider(input.provider, input.settings);
  const quotedSessionId = shellQuote(input.sessionId);

  if (input.provider === "claudeAgent") {
    return `${commandPrefix} --resume ${quotedSessionId}`;
  }

  return `${commandPrefix} resume ${quotedSessionId}`;
}

export function buildDefaultThreadTitle(provider: ProviderKind): string {
  return provider === "codex" ? "Codex thread" : "Claude Code thread";
}

export function providerTerminalLabel(provider: ProviderKind | null | undefined): string {
  if (!provider) {
    return "Terminal";
  }
  if (provider === "claudeAgent") {
    return "Claude Code";
  }
  return PROVIDER_DISPLAY_NAMES[provider];
}
