/**
 * shell-log-incident-search — find a needle in ~9,000 log lines and report facts.
 *
 * Thirty log files across six services, with near-miss error codes scattered
 * around (`E-4417`, `E-4741`, `E-4470`) so a sloppy pattern finds the wrong file.
 * The right answer is derived from the same deterministic generator that wrote
 * the logs, so the grader needs no copy of the logs and cannot be argued with.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { fail, listFiles, makeRng, pad2, pass, readText, writeFiles, type Rng } from "../helpers.js";

const SERVICES = ["auth", "billing", "gateway", "ledger", "notifier", "search"] as const;
const DAYS = [10, 11, 12, 13, 14] as const;
const TARGET_CODE = "E-4471";
const TARGET_SERVICE = "ledger";
const TARGET_DAY = 13;
const TARGET_HITS = 6;

const NOISE_CODES = ["E-1001", "E-1009", "E-2040", "E-2218", "E-3307", "E-4417", "E-4741", "E-4470", "E-5003", "E-5120"];
const ERROR_MESSAGES = ["upstream timeout", "card declined", "retry budget exhausted", "stale cache entry", "queue full", "checksum mismatch on cached page"];
const ACTIONS = ["login", "logout", "refresh", "capture", "refund", "lookup", "enqueue", "render", "sync"];

interface Facts {
  file: string;
  count: number;
  firstSeen: string;
  lastRequestId: string;
}

interface GeneratedLogs {
  files: Record<string, string>;
  facts: Facts;
}

const hex = (rng: Rng, length: number): string =>
  Array.from({ length }, () => "0123456789abcdef"[rng.int(0, 15)]).join("");

function generateLogs(): GeneratedLogs {
  const files: Record<string, string> = {};
  let facts: Facts | undefined;

  for (const [serviceIndex, service] of SERVICES.entries()) {
    for (const [dayIndex, day] of DAYS.entries()) {
      const rng = makeRng(7000 + serviceIndex * 31 + dayIndex);
      const date = `2024-03-${pad2(day)}`;
      const lineCount = rng.int(250, 330);
      let seconds = rng.int(1, 120);
      const lines: string[] = [];
      const timestamps: string[] = [];

      for (let i = 0; i < lineCount; i++) {
        seconds += rng.int(1, 260);
        const stamp = `${date}T${pad2(Math.floor(seconds / 3600))}:${pad2(Math.floor((seconds % 3600) / 60))}:${pad2(seconds % 60)}Z`;
        timestamps.push(stamp);
        const request = `req-${hex(rng, 6)}`;
        const roll = rng.next();
        if (roll < 0.04) {
          lines.push(`${stamp} ERROR ${service} req=${request} code=${rng.pick(NOISE_CODES)} msg="${rng.pick(ERROR_MESSAGES)}"`);
        } else if (roll < 0.1) {
          lines.push(`${stamp} WARN  ${service} req=${request} ms=${rng.int(900, 4000)} slow=true`);
        } else {
          lines.push(`${stamp} INFO  ${service} req=${request} user=u${rng.int(1000, 1999)} action=${rng.pick(ACTIONS)} ms=${rng.int(5, 400)}`);
        }
      }

      if (service === TARGET_SERVICE && day === TARGET_DAY) {
        const positions = new Set<number>();
        while (positions.size < TARGET_HITS) positions.add(rng.int(20, lineCount - 20));
        const ordered = [...positions].sort((a, b) => a - b);
        const requestIds: string[] = [];
        for (const position of ordered) {
          const request = `req-${hex(rng, 6)}`;
          requestIds.push(request);
          lines[position] = `${timestamps[position]} ERROR ${service} req=${request} code=${TARGET_CODE} msg="checksum mismatch on settlement batch"`;
        }
        facts = {
          file: `logs/${service}/${service}-${date}.log`,
          count: TARGET_HITS,
          firstSeen: timestamps[ordered[0] as number] as string,
          lastRequestId: requestIds[requestIds.length - 1] as string,
        };
      }
      files[`logs/${service}/${service}-${date}.log`] = `${lines.join("\n")}\n`;
    }
  }
  if (!facts) throw new Error("log generator did not place the target error");
  return { files, facts };
}

const GENERATED = generateLogs();

/** Parse `key: value` lines into a map; later duplicates win. */
function parseFindings(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([a-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (match?.[1]) found.set(match[1], match[2] ?? "");
  }
  return found;
}

export const shellLogIncidentSearch: DynoTask = {
  id: "shell-log-incident-search",
  title: "Locate an error code in a tree of logs and report the facts",
  category: "shell",
  difficulty: 2,
  instruction:
    `Customers reported failed payouts this week. Somewhere under \`logs/\` (one directory per service, one file per day) ` +
    `there is an error with the code \`${TARGET_CODE}\`; other, similar-looking codes are in there too, so be exact. Find the ` +
    "log file it appears in and write `findings.txt` in this directory with exactly these four lines: " +
    "`file: <path of that log file relative to this directory>`, " +
    `\`count: <how many lines in that file contain ${TARGET_CODE}>\`, ` +
    `\`first_seen: <timestamp of the first such line, copied as it appears in the log>\` and ` +
    "`request_id: <the req= value of the last such line>`. Don't modify the logs.",
  maxIterations: 20,
  timeoutSec: 120,

  setup(dir) {
    writeFiles(dir, GENERATED.files);
  },

  grade(dir) {
    const text = readText(dir, "findings.txt");
    if (text === undefined) return fail("findings.txt does not exist");
    const found = parseFindings(text);
    const { facts } = GENERATED;

    const rawFile = (found.get("file") ?? "").trim();
    const file = path.posix.normalize(rawFile.startsWith(dir) ? path.posix.relative(dir, rawFile) : rawFile);
    if (file !== facts.file) return fail(`file is ${JSON.stringify(rawFile)}, expected ${facts.file}`);
    if (found.get("count") !== String(facts.count)) return fail(`count is ${JSON.stringify(found.get("count"))}, expected ${facts.count}`);
    if (found.get("first_seen") !== facts.firstSeen) return fail(`first_seen is ${JSON.stringify(found.get("first_seen"))}, expected ${facts.firstSeen}`);
    if (found.get("request_id") !== facts.lastRequestId) {
      return fail(`request_id is ${JSON.stringify(found.get("request_id"))}, expected the req= value of the LAST ${TARGET_CODE} line`);
    }

    // The logs are evidence: any change to them invalidates the answer.
    for (const [relative, content] of Object.entries(GENERATED.files)) {
      if (readText(dir, relative) !== content) return fail(`${relative} was modified or removed`);
    }
    return pass(`identified ${facts.file} with count, first_seen and request_id`);
  },

  oracle(dir) {
    const needle = ` code=${TARGET_CODE} `;
    const matches = listFiles(dir).filter(
      (relative) => relative.startsWith("logs/") && fs.readFileSync(path.join(dir, relative), "utf8").includes(needle),
    );
    const [file] = matches;
    if (matches.length !== 1 || file === undefined) throw new Error(`expected exactly one log with ${TARGET_CODE}, found ${matches.length}`);
    const hits = fs
      .readFileSync(path.join(dir, file), "utf8")
      .split("\n")
      .filter((line) => line.includes(needle));
    const first = /^(\S+)/.exec(hits[0] ?? "")?.[1];
    const last = /req=(\S+)/.exec(hits[hits.length - 1] ?? "")?.[1];
    fs.writeFileSync(path.join(dir, "findings.txt"), `file: ${file}\ncount: ${hits.length}\nfirst_seen: ${first}\nrequest_id: ${last}\n`);
  },
};
