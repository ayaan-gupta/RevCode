/**
 * edit-near-identical-blocks — five senders whose retry loops are textually
 * identical apart from the channel name; only one may change.
 *
 * An `oldText` that is just the loop header matches five places and is rejected,
 * and a global search-and-replace changes all of them. The grader measures how
 * many delivery attempts each channel really makes.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { clip, fail, pass, pythonCode, writeFiles } from "../helpers.js";

const MODULE = "notifier.py";

const CHANNELS: ReadonlyArray<{ name: string; doc: string }> = [
  { name: "email", doc: "Deliver message through the SMTP relay." },
  { name: "push", doc: "Deliver message as a mobile push notification." },
  { name: "sms", doc: "Deliver message as a text message." },
  { name: "slack", doc: "Deliver message to the on-call Slack channel." },
  { name: "webhook", doc: "Deliver message to the customer's webhook endpoint." },
];

function sender(channel: { name: string; doc: string }, attempts: number): string {
  return String.raw`def send_${channel.name}(message, transport):
    """${channel.doc}"""
    last_error = None
    for attempt in range(${attempts}):
        try:
            transport.send("${channel.name}", message)
            return attempt + 1
        except TransientError as exc:
            last_error = exc
    raise DeliveryFailed("${channel.name}", last_error)
`;
}

function renderModule(attemptsFor: (channel: string) => number): string {
  const header = String.raw`"""Outbound notification senders.

Every sender retries transient transport errors a fixed number of times and
returns how many attempts it needed. When it runs out of attempts it raises
DeliveryFailed. Transports only need a send(channel, message) method.
"""


class TransientError(Exception):
    """The transport failed in a way that is worth retrying."""


class DeliveryFailed(Exception):
    def __init__(self, channel, cause):
        super().__init__(f"could not deliver via {channel}: {cause}")
        self.channel = channel
        self.cause = cause
`;
  const body = CHANNELS.map((channel) => sender(channel, attemptsFor(channel.name))).join("\n\n");
  return `${header}\n\n${body}`;
}

const PROBE = String.raw`
import json
import notifier


class Flaky:
    def __init__(self, failures):
        self.failures = failures
        self.calls = {}

    def send(self, channel, message):
        n = self.calls.get(channel, 0) + 1
        self.calls[channel] = n
        if n <= self.failures:
            raise notifier.TransientError("boom")


out = {}
for channel in ("email", "push", "sms", "slack", "webhook"):
    send = getattr(notifier, "send_" + channel)
    always = Flaky(10**6)
    try:
        send("hi", always)
        outcome = "returned"
    except notifier.DeliveryFailed as exc:
        outcome = "failed:" + exc.channel
    results = {"attempts_when_always_failing": always.calls[channel], "outcome": outcome}
    for failures in (0, 2, 3, 4):
        flaky = Flaky(failures)
        try:
            results["after_%d_failures" % failures] = send("hi", flaky)
        except notifier.DeliveryFailed:
            results["after_%d_failures" % failures] = "failed"
    out[channel] = results
print(json.dumps(out))
`;

function expectedFor(channel: string): Record<string, unknown> {
  const attempts = channel === "sms" ? 5 : 3;
  const result: Record<string, unknown> = {
    attempts_when_always_failing: attempts,
    outcome: `failed:${channel}`,
  };
  for (const failures of [0, 2, 3, 4]) {
    result[`after_${failures}_failures`] = failures < attempts ? failures + 1 : "failed";
  }
  return result;
}

export const editNearIdenticalBlocks: DynoTask = {
  id: "edit-near-identical-blocks",
  title: "Change one of five near-identical retry loops",
  category: "edit",
  difficulty: 2,
  instruction:
    "In `notifier.py`, the senders all give up after 3 attempts, but our SMS gateway is much flakier than the rest. " +
    "Make `send_sms` try up to 5 times before it raises `DeliveryFailed`. The email, push, Slack and webhook senders must " +
    "keep their current behaviour, so only the SMS one should change.",
  maxIterations: 20,
  timeoutSec: 120,

  setup(dir) {
    writeFiles(dir, { [MODULE]: renderModule(() => 3) });
  },

  async grade(dir) {
    const result = await pythonCode(PROBE, { cwd: dir, timeoutMs: 15_000 });
    if (result.code !== 0) return fail(`probe failed: ${clip(result.stderr)}`);
    let actual: Record<string, Record<string, unknown>>;
    try {
      actual = JSON.parse(result.stdout) as typeof actual;
    } catch {
      return fail(`unparseable probe output: ${clip(result.stdout)}`);
    }
    for (const { name } of CHANNELS) {
      const want = JSON.stringify(expectedFor(name));
      const got = JSON.stringify(actual[name]);
      if (want !== got) {
        const attempts = actual[name]?.attempts_when_always_failing;
        return fail(`send_${name} behaves wrongly: made ${String(attempts)} attempts when always failing (expected ${name === "sms" ? 5 : 3})`);
      }
    }
    return pass("send_sms retries 5 times; the other four senders still retry 3 times");
  },

  oracle(dir) {
    const file = path.join(dir, MODULE);
    const text = fs.readFileSync(file, "utf8");
    const marker = "def send_sms(message, transport):";
    const start = text.indexOf(marker);
    const loop = "for attempt in range(3):";
    const at = text.indexOf(loop, start);
    fs.writeFileSync(file, text.slice(0, at) + "for attempt in range(5):" + text.slice(at + loop.length));
  },
};
