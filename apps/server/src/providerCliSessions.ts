import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ServerResolveProviderSessionError,
  type ServerResolveProviderSessionInput,
  type ServerResolveProviderSessionResult,
} from "@t3tools/contracts";

interface CodexSessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
}

const CODEX_SESSION_GRACE_MS = 15_000;
const FIRST_LINE_READ_CHUNK_BYTES = 8_192;
const MAX_FIRST_LINE_BYTES = 512 * 1_024;

function normalizeDirectory(value: string): string {
  return path.resolve(value);
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

export async function resolveProviderSession(
  input: ServerResolveProviderSessionInput,
): Promise<ServerResolveProviderSessionResult> {
  try {
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
