/**
 * Harness profile — the tunable behaviors of the harness itself.
 *
 * The same model can score wildly differently depending on how the harness
 * presents tools, prompts, and edits (Terminal-Bench shows 10-18 point swings
 * from the harness alone). A profile makes those choices explicit data so that
 * Dyno (`revcode tune`) can search over them per model and persist the winner.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { profilesDir, safeSegment } from "../config/paths.js";

/** How the agent changes existing files. */
export type EditMode = "replace" | "patch" | "anchored" | "whole";
/** Shape of the system prompt. */
export type PromptStyle = "standard" | "terse" | "checklist";
/** How tool JSON schemas are presented to the model. */
export type ToolSchemaStyle = "full" | "flat";

export interface HarnessProfile {
  version: 1;
  /** Which edit tool(s) the model sees. */
  editMode: EditMode;
  promptStyle: PromptStyle;
  toolSchema: ToolSchemaStyle;
  /** Run contiguous read-only tool calls concurrently. */
  parallelTools: boolean;
  temperature: number;
  /** Max completion tokens per model call. */
  maxTokens: number;
  /** Assumed context window, in estimated tokens. */
  contextLimit: number;
  /** Fraction of contextLimit at which compaction starts. */
  compactTrigger: number;
  /** Challenge "done" once if files changed but nothing was verified. */
  verifyGate: boolean;
  /** Headless runs: audit the work against the original task before accepting "done". */
  completionGate: boolean;
}

export const DEFAULT_PROFILE: Readonly<HarnessProfile> = Object.freeze({
  version: 1,
  editMode: "replace",
  promptStyle: "standard",
  toolSchema: "full",
  parallelTools: true,
  temperature: 0.2,
  maxTokens: 16_384,
  contextLimit: 120_000,
  compactTrigger: 0.7,
  verifyGate: true,
  completionGate: true,
});

/** The knobs Dyno is allowed to turn, with their candidate values. */
export const PROFILE_SEARCH_SPACE = {
  editMode: ["replace", "patch", "anchored", "whole"],
  promptStyle: ["standard", "terse", "checklist"],
  toolSchema: ["full", "flat"],
  parallelTools: [true, false],
  temperature: [0, 0.2, 0.6],
  verifyGate: [true, false],
  completionGate: [true, false],
} as const satisfies Partial<Record<keyof HarnessProfile, readonly unknown[]>>;

export type TunableKnob = keyof typeof PROFILE_SEARCH_SPACE;

const EDIT_MODES: readonly EditMode[] = ["replace", "patch", "anchored", "whole"];
const PROMPT_STYLES: readonly PromptStyle[] = ["standard", "terse", "checklist"];
const TOOL_SCHEMAS: readonly ToolSchemaStyle[] = ["full", "flat"];

/** Coerce arbitrary JSON into a valid profile, falling back per-field to defaults. */
export function sanitizeProfile(raw: unknown, base: HarnessProfile = DEFAULT_PROFILE): HarnessProfile {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  const num = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;

  return {
    version: 1,
    editMode: pick(input.editMode, EDIT_MODES, base.editMode),
    promptStyle: pick(input.promptStyle, PROMPT_STYLES, base.promptStyle),
    toolSchema: pick(input.toolSchema, TOOL_SCHEMAS, base.toolSchema),
    parallelTools: bool(input.parallelTools, base.parallelTools),
    temperature: num(input.temperature, base.temperature, 0, 2),
    maxTokens: Math.round(num(input.maxTokens, base.maxTokens, 256, 200_000)),
    contextLimit: Math.round(num(input.contextLimit, base.contextLimit, 4_000, 2_000_000)),
    compactTrigger: num(input.compactTrigger, base.compactTrigger, 0.2, 0.95),
    verifyGate: bool(input.verifyGate, base.verifyGate),
    completionGate: bool(input.completionGate, base.completionGate),
  };
}

/** Return a copy of `base` with `patch` applied (and re-validated). */
export function withProfile(base: HarnessProfile, patch: Partial<HarnessProfile>): HarnessProfile {
  return sanitizeProfile({ ...base, ...patch }, base);
}

/** Stable key for a profile's tunable fields (used to cache benchmark runs). */
export function profileKey(profile: HarnessProfile): string {
  const keys = Object.keys(PROFILE_SEARCH_SPACE) as TunableKnob[];
  return keys.map((key) => `${key}=${String(profile[key])}`).join(";");
}

/** What differs between two profiles, as `knob: a → b` strings. */
export function describeProfileDiff(from: HarnessProfile, to: HarnessProfile): string[] {
  const out: string[] = [];
  for (const key of Object.keys(PROFILE_SEARCH_SPACE) as TunableKnob[]) {
    if (from[key] !== to[key]) {
      out.push(`${key}: ${String(from[key])} → ${String(to[key])}`);
    }
  }
  return out;
}

// --- persistence -----------------------------------------------------------

/** A tuned profile plus the evidence that justified it. */
export interface StoredProfile {
  profile: HarnessProfile;
  provider: string;
  model: string;
  tunedAt: string;
  /** Baseline and tuned scores from the Dyno run that produced this profile. */
  evidence?: {
    suite: string;
    baselineScore: number;
    tunedScore: number;
    tasks: number;
    trials: number;
  };
}

export function profilePath(provider: string, model: string): string {
  return path.join(profilesDir(), `${safeSegment(provider)}__${safeSegment(model)}.json`);
}

export function loadStoredProfile(provider: string, model: string): StoredProfile | undefined {
  const file = profilePath(provider, model);
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredProfile>;
    return {
      provider,
      model,
      tunedAt: typeof parsed.tunedAt === "string" ? parsed.tunedAt : "",
      profile: sanitizeProfile(parsed.profile),
      evidence: parsed.evidence,
    };
  } catch {
    return undefined;
  }
}

export function saveStoredProfile(stored: StoredProfile): string {
  const file = profilePath(stored.provider, stored.model);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  return file;
}
