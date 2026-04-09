import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  ServerCreateOpenCodeSessionError,
  ServerResolveProviderSessionError,
  type ServerResolveProviderSessionInput,
  type ServerResolveProviderSessionResult,
} from "@t3tools/contracts";

interface CodexSessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
}

interface OpenCodeSessionMeta {
  id: string;
  directory: string;
  createdAtMs: number;
}

interface OpenCodeCreatedSession {
  id: string;
}

interface SqliteStatementLike {
  all(): unknown[];
}

interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

const CODEX_SESSION_GRACE_MS = 15_000;
const OPENCODE_SESSION_GRACE_MS = 15_000;
const FIRST_LINE_READ_CHUNK_BYTES = 8_192;
const MAX_FIRST_LINE_BYTES = 512 * 1_024;
const execFileAsync = promisify(execFile);

function normalizeDirectory(value: string): string {
  return path.resolve(value);
}

async function findBinaryInNvmPaths(binaryName: string): Promise<string | null> {
  const nvmDir = process.env.NVM_DIR ?? path.join(os.homedir(), ".nvm");
  const versionsDir = path.join(nvmDir, "versions", "node");

  let nodeDirs: string[];
  try {
    nodeDirs = await fs.readdir(versionsDir);
  } catch {
    return null;
  }

  nodeDirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  for (const nodeDir of nodeDirs) {
    const candidate = path.join(versionsDir, nodeDir, "bin", binaryName);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not found or not executable
    }
  }

  return null;
}

async function readFirstLine(filePath: string): Promise<string | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let bytesConsumed = 0;

    while (bytesConsumed < MAX_FIRST_LINE_BYTES) {
      const buffer = Buffer.alloc(FIRST_LINE_READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytesConsumed);
      if (bytesRead <= 0) {
        break;
      }

      const chunk = buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      bytesConsumed += bytesRead;

      if (chunk.includes(0x0a)) {
        break;
      }
    }

    if (chunks.length === 0) {
      return null;
    }

    const firstLineChunk = Buffer.concat(chunks).toString("utf8");
    const newlineIndex = firstLineChunk.indexOf("\n");
    return newlineIndex >= 0 ? firstLineChunk.slice(0, newlineIndex) : firstLineChunk;
  } finally {
    await handle.close();
  }
}

async function listFilesRecursive(rootDirectory: string): Promise<string[]> {
  const directories = [rootDirectory];
  const filePaths: string[] = [];

  while (directories.length > 0) {
    const currentDirectory = directories.pop();
    if (!currentDirectory) {
      continue;
    }

    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        directories.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        filePaths.push(entryPath);
      }
    }
  }

  return filePaths;
}

function parseCodexSessionMeta(rawLine: string | null): CodexSessionMeta | null {
  if (!rawLine) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawLine) as {
      type?: unknown;
      payload?: {
        id?: unknown;
        timestamp?: unknown;
        cwd?: unknown;
      };
    };
    if (parsed.type !== "session_meta") {
      return null;
    }
    const payload = parsed.payload;
    if (!payload) {
      return null;
    }
    if (
      typeof payload.id !== "string" ||
      typeof payload.timestamp !== "string" ||
      typeof payload.cwd !== "string"
    ) {
      return null;
    }
    return {
      id: payload.id,
      timestamp: payload.timestamp,
      cwd: payload.cwd,
    };
  } catch {
    return null;
  }
}

async function resolveCodexSessionId(input: {
  cwd: string;
  startedAt: string;
  codexHomePath?: string;
  excludeSessionId?: string;
}): Promise<string | null> {
  const codexHomePath =
    input.codexHomePath?.trim() || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sessionsDirectory = path.join(codexHomePath, "sessions");
  let sessionFiles: string[];

  try {
    sessionFiles = await listFilesRecursive(sessionsDirectory);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const normalizedCwd = normalizeDirectory(input.cwd);
  const startedAtMs = Date.parse(input.startedAt);
  const lowerBoundMs = Number.isFinite(startedAtMs) ? startedAtMs - CODEX_SESSION_GRACE_MS : 0;
  const matches: Array<{ id: string; timestampMs: number }> = [];

  for (const filePath of sessionFiles) {
    const firstLine = await readFirstLine(filePath).catch(() => null);
    const sessionMeta = parseCodexSessionMeta(firstLine);
    if (!sessionMeta) {
      continue;
    }
    if (input.excludeSessionId && sessionMeta.id === input.excludeSessionId) {
      continue;
    }
    if (normalizeDirectory(sessionMeta.cwd) !== normalizedCwd) {
      continue;
    }
    const timestampMs = Date.parse(sessionMeta.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs < lowerBoundMs) {
      continue;
    }
    matches.push({
      id: sessionMeta.id,
      timestampMs,
    });
  }

  matches.sort((left, right) => left.timestampMs - right.timestampMs);
  return matches.at(-1)?.id ?? null;
}

function parseOpenCodeSessionList(raw: string): OpenCodeSessionMeta[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as unknown;
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "items" in parsed && Array.isArray(parsed.items)
      ? parsed.items
      : [];

  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const session = candidate as {
      id?: unknown;
      directory?: unknown;
      created?: unknown;
    };
    if (typeof session.id !== "string" || typeof session.directory !== "string") {
      return [];
    }
    const createdAtMs =
      typeof session.created === "number" && Number.isFinite(session.created)
        ? session.created
        : NaN;
    if (!Number.isFinite(createdAtMs)) {
      return [];
    }
    return [
      {
        id: session.id,
        directory: session.directory,
        createdAtMs,
      } satisfies OpenCodeSessionMeta,
    ];
  });
}

function resolveOpenCodeDbPaths(): string[] {
  const candidates = new Set<string>();
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  const homeDirectory = os.homedir();

  if (xdgDataHome) {
    candidates.add(path.join(xdgDataHome, "opencode", "opencode.db"));
  }

  candidates.add(path.join(homeDirectory, ".local", "share", "opencode", "opencode.db"));
  candidates.add(
    path.join(
      homeDirectory,
      "Library",
      "Application Support",
      "ai.opencode.desktop",
      "opencode.db",
    ),
  );

  return [...candidates];
}

async function openSqliteDatabase(databasePath: string): Promise<SqliteDatabaseLike> {
  try {
    const sqliteModule = await import("node:sqlite");
    const database = new sqliteModule.DatabaseSync(databasePath, {
      open: true,
      readOnly: true,
    });
    return database as SqliteDatabaseLike;
  } catch (nodeSqliteError) {
    try {
      const sqliteModule = await import("bun:sqlite");
      const database = new sqliteModule.Database(databasePath, {
        readonly: true,
      });
      return database as SqliteDatabaseLike;
    } catch {
      throw nodeSqliteError;
    }
  }
}

async function queryOpenCodeSessionsViaSqliteCli(databasePath: string): Promise<
  Array<{
    id: string;
    directory: string;
    time_created: number;
  }>
> {
  const query = [
    "SELECT id, directory, time_created",
    "FROM session",
    "WHERE time_archived IS NULL",
    "ORDER BY time_created ASC;",
  ].join(" ");
  const { stdout } = await execFileAsync("sqlite3", ["-tabs", "-noheader", databasePath, query], {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [id, directory, timeCreatedRaw] = line.split("\t");
      if (!id || !directory || !timeCreatedRaw) {
        return [];
      }
      const time_created = Number(timeCreatedRaw);
      if (!Number.isFinite(time_created)) {
        return [];
      }
      return [{ id, directory, time_created }];
    });
}

async function resolveOpenCodeSessionIdFromDb(input: {
  cwd: string;
  startedAt: string;
  excludeSessionId?: string;
}): Promise<string | null> {
  const normalizedCwd = normalizeDirectory(input.cwd);
  const startedAtMs = Date.parse(input.startedAt);
  const lowerBoundMs = Number.isFinite(startedAtMs) ? startedAtMs - OPENCODE_SESSION_GRACE_MS : 0;

  for (const databasePath of resolveOpenCodeDbPaths()) {
    try {
      await fs.access(databasePath, fsConstants.R_OK);
    } catch {
      continue;
    }

    let database: SqliteDatabaseLike | undefined;
    try {
      const rows = await openSqliteDatabase(databasePath)
        .then((openedDatabase) => {
          database = openedDatabase;
          return database
            .prepare(
              `
                SELECT id, directory, time_created
                FROM session
                WHERE time_archived IS NULL
                ORDER BY time_created ASC
              `,
            )
            .all() as Array<{
            id: string;
            directory: string;
            time_created: number;
          }>;
        })
        .catch(async () => queryOpenCodeSessionsViaSqliteCli(databasePath));

      const match = rows.find((row) => {
        if (typeof row.id !== "string" || typeof row.directory !== "string") {
          return false;
        }
        if (input.excludeSessionId && row.id === input.excludeSessionId) {
          return false;
        }
        if (normalizeDirectory(row.directory) !== normalizedCwd) {
          return false;
        }
        return typeof row.time_created === "number" && Number.isFinite(row.time_created)
          ? row.time_created >= lowerBoundMs
          : false;
      });

      if (match) {
        return match.id;
      }
    } catch {
      // ignore db fallback errors and continue checking remaining locations
    } finally {
      if (database) {
        database.close();
      }
    }
  }

  return null;
}

async function resolveOpenCodeBinaryPath(configuredBinaryPath?: string): Promise<string> {
  const candidate = configuredBinaryPath?.trim() || "opencode";
  try {
    await execFileAsync(candidate, ["--version"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return candidate;
  } catch (error) {
    const isEnoent =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "ENOENT";

    if (!isEnoent || path.isAbsolute(candidate)) {
      throw error;
    }

    const nvmBinaryPath = await findBinaryInNvmPaths("opencode");
    if (!nvmBinaryPath) {
      throw error;
    }
    return nvmBinaryPath;
  }
}

async function withOpenCodeServer<T>(
  input: {
    binaryPath?: string;
    cwd?: string;
  },
  run: (serverUrl: string) => Promise<T>,
): Promise<T> {
  const binaryPath = await resolveOpenCodeBinaryPath(input.binaryPath);

  const child = spawn(binaryPath, ["serve", "--hostname=127.0.0.1", "--port=0"], {
    cwd: input.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const serverUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for opencode server to start."));
    }, 8_000);
    let output = "";

    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = output.match(/opencode server listening on\s+(https?:\/\/\S+)/);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          output.trim().length > 0
            ? `opencode server exited with code ${code}: ${output.trim()}`
            : `opencode server exited with code ${code}.`,
        ),
      );
    });
  });

  try {
    return await run(serverUrl);
  } finally {
    child.kill();
  }
}

export async function createOpenCodeSession(input: {
  cwd: string;
  title?: string;
  binaryPath?: string;
}): Promise<{ sessionId: string }> {
  try {
    const session = await withOpenCodeServer(
      {
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        cwd: input.cwd,
      },
      async (serverUrl) => {
        const requestUrl = new URL("/session", serverUrl);
        requestUrl.searchParams.set("directory", input.cwd);
        const requestBody = input.title?.trim() ? { title: input.title.trim() } : {};

        const response = await fetch(requestUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            body.trim().length > 0
              ? `opencode session create failed (${response.status}): ${body.trim()}`
              : `opencode session create failed with status ${response.status}.`,
          );
        }

        const parsed = (await response.json()) as Partial<OpenCodeCreatedSession>;
        if (typeof parsed.id !== "string" || parsed.id.trim().length === 0) {
          throw new Error("opencode session create returned no session id.");
        }
        return { id: parsed.id };
      },
    );

    return { sessionId: session.id };
  } catch (error) {
    throw new ServerCreateOpenCodeSessionError({
      message: error instanceof Error ? error.message : "Failed to create opencode session.",
    });
  }
}

async function resolveOpenCodeSessionId(input: {
  cwd: string;
  startedAt: string;
  binaryPath?: string;
  excludeSessionId?: string;
}): Promise<string | null> {
  const configuredBinaryPath = input.binaryPath?.trim() || "opencode";

  const runSessionList = (binary: string) =>
    execFileAsync(binary, ["session", "list", "--format", "json", "--max-count", "200"], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });

  let stdout = "";
  let cliError: unknown = null;
  try {
    ({ stdout } = await runSessionList(configuredBinaryPath));
  } catch (firstError) {
    const isEnoent =
      typeof firstError === "object" &&
      firstError !== null &&
      "code" in firstError &&
      (firstError as { code: unknown }).code === "ENOENT";

    // For absolute paths, the user explicitly configured a location — don't guess alternatives.
    if (!isEnoent || path.isAbsolute(configuredBinaryPath)) {
      cliError = firstError;
    } else {
      const nvmBinaryPath = await findBinaryInNvmPaths("opencode");
      if (nvmBinaryPath) {
        try {
          ({ stdout } = await runSessionList(nvmBinaryPath));
          cliError = null;
        } catch (nvmError) {
          cliError = nvmError;
        }
      } else {
        cliError = firstError;
      }
    }
  }

  const normalizedCwd = normalizeDirectory(input.cwd);
  const startedAtMs = Date.parse(input.startedAt);
  const lowerBoundMs = Number.isFinite(startedAtMs) ? startedAtMs - OPENCODE_SESSION_GRACE_MS : 0;
  const sessions = parseOpenCodeSessionList(stdout);
  const matches = sessions
    .filter((session) => {
      if (input.excludeSessionId && session.id === input.excludeSessionId) {
        return false;
      }
      return (
        normalizeDirectory(session.directory) === normalizedCwd &&
        session.createdAtMs >= lowerBoundMs
      );
    })
    .toSorted((left, right) => left.createdAtMs - right.createdAtMs);

  if (matches.length > 0) {
    return matches.at(-1)?.id ?? null;
  }

  const dbMatch = await resolveOpenCodeSessionIdFromDb(input);
  if (dbMatch) {
    return dbMatch;
  }

  if (cliError) {
    throw cliError;
  }

  return null;
}

export async function resolveProviderSession(
  input: ServerResolveProviderSessionInput,
): Promise<ServerResolveProviderSessionResult> {
  try {
    if (input.provider === "opencode") {
      return {
        sessionId: await resolveOpenCodeSessionId({
          cwd: input.cwd,
          startedAt: input.startedAt,
          ...(input.openCodeBinaryPath ? { binaryPath: input.openCodeBinaryPath } : {}),
          ...(input.excludeSessionId ? { excludeSessionId: input.excludeSessionId } : {}),
        }),
      };
    }

    if (input.provider === "claudeAgent") {
      return { sessionId: null };
    }

    return {
      sessionId: await resolveCodexSessionId({
        cwd: input.cwd,
        startedAt: input.startedAt,
        ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
        ...(input.excludeSessionId ? { excludeSessionId: input.excludeSessionId } : {}),
      }),
    };
  } catch (error) {
    throw new ServerResolveProviderSessionError({
      message:
        error instanceof Error ? error.message : "Failed to resolve provider terminal session.",
    });
  }
}
