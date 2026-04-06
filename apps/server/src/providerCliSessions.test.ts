import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { resolveProviderSession } from "./providerCliSessions";

const tempDirectories: string[] = [];

async function makeTempCodexHome(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "t2code-provider-cli-sessions-"));
  tempDirectories.push(directory);
  return directory;
}

async function writeCodexSession(input: {
  codexHomePath: string;
  sessionId: string;
  timestamp: string;
  cwd: string;
  extraText?: string;
}): Promise<void> {
  const sessionFilePath = path.join(
    input.codexHomePath,
    "sessions",
    "2026",
    "04",
    "06",
    `${input.sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(sessionFilePath), { recursive: true });
  const metadataLine = JSON.stringify({
    timestamp: input.timestamp,
    type: "session_meta",
    payload: {
      id: input.sessionId,
      timestamp: input.timestamp,
      cwd: input.cwd,
      base_instructions: {
        text: input.extraText ?? "",
      },
    },
  });
  await fs.writeFile(sessionFilePath, `${metadataLine}\n`, "utf8");
}

describe("resolveProviderSession", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirectories
        .splice(0, tempDirectories.length)
        .map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it("resolves Codex sessions from long modern session metadata lines", async () => {
    const codexHomePath = await makeTempCodexHome();
    const cwd = "/Users/paul/development/investment_strats/social/dumbmoney";
    const sessionId = "019d6460-689f-7c83-94a0-ef64212ac077";

    await writeCodexSession({
      codexHomePath,
      sessionId,
      cwd,
      timestamp: "2026-04-06T19:58:53.091Z",
      extraText: "x".repeat(10_000),
    });

    await expect(
      resolveProviderSession({
        provider: "codex",
        cwd,
        startedAt: "2026-04-06T19:58:50.000Z",
        codexHomePath,
      }),
    ).resolves.toEqual({ sessionId });
  });

  it("returns the most recent session when multiple sessions match", async () => {
    const codexHomePath = await makeTempCodexHome();
    const cwd = "/Users/paul/development/investment_strats/social/dumbmoney";
    const olderSessionId = "019d6460-0000-0000-0000-000000000001";
    const newerSessionId = "019d6460-0000-0000-0000-000000000002";

    await writeCodexSession({
      codexHomePath,
      sessionId: olderSessionId,
      cwd,
      timestamp: "2026-04-06T19:58:53.000Z",
    });
    await writeCodexSession({
      codexHomePath,
      sessionId: newerSessionId,
      cwd,
      timestamp: "2026-04-06T19:59:10.000Z",
    });

    await expect(
      resolveProviderSession({
        provider: "codex",
        cwd,
        startedAt: "2026-04-06T19:58:50.000Z",
        codexHomePath,
      }),
    ).resolves.toEqual({ sessionId: newerSessionId });
  });

  it("skips the session with excludeSessionId and returns the next most recent match", async () => {
    const codexHomePath = await makeTempCodexHome();
    const cwd = "/Users/paul/development/investment_strats/social/dumbmoney";
    const appServerSessionId = "019d6460-0000-0000-0000-app-server-001";
    const cliSessionId = "019d6460-0000-0000-0000-cli-session-002";

    await writeCodexSession({
      codexHomePath,
      sessionId: appServerSessionId,
      cwd,
      timestamp: "2026-04-06T19:58:53.000Z",
    });
    await writeCodexSession({
      codexHomePath,
      sessionId: cliSessionId,
      cwd,
      timestamp: "2026-04-06T19:59:10.000Z",
    });

    await expect(
      resolveProviderSession({
        provider: "codex",
        cwd,
        startedAt: "2026-04-06T19:58:50.000Z",
        codexHomePath,
        excludeSessionId: appServerSessionId,
      }),
    ).resolves.toEqual({ sessionId: cliSessionId });
  });

  it("returns null when the only matching session is excluded", async () => {
    const codexHomePath = await makeTempCodexHome();
    const cwd = "/Users/paul/development/investment_strats/social/dumbmoney";
    const sessionId = "019d6460-0000-0000-0000-only-session-1";

    await writeCodexSession({
      codexHomePath,
      sessionId,
      cwd,
      timestamp: "2026-04-06T19:58:53.000Z",
    });

    await expect(
      resolveProviderSession({
        provider: "codex",
        cwd,
        startedAt: "2026-04-06T19:58:50.000Z",
        codexHomePath,
        excludeSessionId: sessionId,
      }),
    ).resolves.toEqual({ sessionId: null });
  });
});
