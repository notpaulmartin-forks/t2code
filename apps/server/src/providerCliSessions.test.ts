import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { resolveProviderSession } from "./providerCliSessions";

const tempDirectories: string[] = [];
const execFileAsync = promisify(execFile);

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

async function writeOpenCodeSession(input: {
  dataHomePath: string;
  sessionId: string;
  directory: string;
  createdAtMs: number;
  title?: string;
}): Promise<void> {
  const databaseDirectory = path.join(input.dataHomePath, "opencode");
  await fs.mkdir(databaseDirectory, { recursive: true });
  const databasePath = path.join(databaseDirectory, "opencode.db");
  const escapedDirectory = input.directory.replaceAll("'", "''");
  const escapedTitle = (input.title ?? "Recovered session").replaceAll("'", "''");
  const escapedSessionId = input.sessionId.replaceAll("'", "''");
  await execFileAsync("sqlite3", [
    databasePath,
    `
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        share_url TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        summary_diffs TEXT,
        revert TEXT,
        permission TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_compacting INTEGER,
        time_archived INTEGER,
        workspace_id TEXT
      );
      INSERT INTO session (
        id, project_id, slug, directory, title, version, time_created, time_updated
      ) VALUES (
        '${escapedSessionId}',
        'global',
        '${escapedSessionId}',
        '${escapedDirectory}',
        '${escapedTitle}',
        '0.0.0',
        ${input.createdAtMs},
        ${input.createdAtMs}
      );
    `,
  ]);
}

describe("resolveProviderSession", () => {
  afterEach(async () => {
    delete process.env.XDG_DATA_HOME;
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

  it("falls back to the opencode sqlite store when cli listing has no cwd match", async () => {
    const dataHomePath = await makeTempCodexHome();
    const cwd = "/Users/paul/development/investment_strats/social/dumbmoney";
    const sessionId = "ses_29aff9092ffe7GjoyzBSFRpQ0F";
    process.env.XDG_DATA_HOME = dataHomePath;

    await writeOpenCodeSession({
      dataHomePath,
      sessionId,
      directory: cwd,
      createdAtMs: Date.parse("2026-04-08T21:47:20.589Z"),
      title: "Greeting",
    });

    await expect(
      resolveProviderSession({
        provider: "opencode",
        cwd,
        startedAt: "2026-04-08T21:47:16.541Z",
        openCodeBinaryPath: "/usr/bin/true",
      }),
    ).resolves.toEqual({ sessionId });
  });

  it("excludes sqlite fallback sessions that match excludeSessionId", async () => {
    const dataHomePath = await makeTempCodexHome();
    const cwd = "/Users/paul/development/investment_strats/social/dumbmoney";
    const sessionId = "ses_29aff9092ffe7GjoyzBSFRpQ0F";
    process.env.XDG_DATA_HOME = dataHomePath;

    await writeOpenCodeSession({
      dataHomePath,
      sessionId,
      directory: cwd,
      createdAtMs: Date.parse("2026-04-08T21:47:20.589Z"),
    });

    await expect(
      resolveProviderSession({
        provider: "opencode",
        cwd,
        startedAt: "2026-04-08T21:47:16.541Z",
        openCodeBinaryPath: "/usr/bin/true",
        excludeSessionId: sessionId,
      }),
    ).resolves.toEqual({ sessionId: null });
  });
});
