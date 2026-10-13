/**
 * Session persistence.
 *
 * Each interactive session is snapshotted to `~/.revcode/sessions/<id>.json`
 * after every turn (atomic temp-file + rename, so a crash mid-write never
 * corrupts the previous snapshot). Snapshots hold the full message list, which
 * is exactly what the engine needs to resume — compaction rewrites history in
 * place, so appending a log would not reproduce it.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LlmMessage } from "../llm/client.js";
import { safeSegment, sessionsDir } from "../config/paths.js";

export interface SessionMeta {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  /** Universe this session runs inside, when any. */
  universeId?: string;
}

export interface SessionSnapshot {
  meta: SessionMeta;
  messages: LlmMessage[];
}

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function sessionFile(id: string): string {
  return path.join(sessionsDir(), `${safeSegment(id)}.json`);
}

export function saveSession(snapshot: SessionSnapshot): void {
  const file = sessionFile(snapshot.meta.id);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(snapshot), "utf8");
  renameSync(temp, file);
}

export function loadSession(id: string): SessionSnapshot | undefined {
  const file = sessionFile(id);
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SessionSnapshot;
    if (!parsed?.meta?.id || !Array.isArray(parsed.messages)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** All sessions, newest first. */
export function listSessions(filter?: { cwd?: string }): SessionMeta[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const snapshot = loadSession(entry.slice(0, -".json".length));
    if (snapshot && (!filter?.cwd || path.resolve(snapshot.meta.cwd) === path.resolve(filter.cwd))) {
      metas.push(snapshot.meta);
    }
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function latestSession(cwd: string): SessionMeta | undefined {
  return listSessions({ cwd })[0];
}

export function deriveTitle(messages: LlmMessage[]): string {
  const first = messages.find((m) => m.role === "user" && !m.content.startsWith("[harness]"));
  const text = (first?.content ?? "untitled").replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
