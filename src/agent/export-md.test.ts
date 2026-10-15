import { describe, expect, it } from "vitest";
import { conversationToMarkdown } from "./export-md.js";

const meta = { sessionId: "s1", model: "glm-5.2", provider: "zai", cwd: "/proj", exportedAt: new Date("2026-01-02T03:04:05Z") };

describe("conversationToMarkdown", () => {
  it("renders user, assistant and tool messages and omits the system prompt", () => {
    const md = conversationToMarkdown(
      [
        { role: "system", content: "SECRET SYSTEM PROMPT" },
        { role: "user", content: "fix it" },
        { role: "assistant", content: "On it.", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "a.ts" } }] },
        { role: "tool", toolCallId: "1", name: "read_file", content: JSON.stringify({ result: { content: "1|x" } }) },
        { role: "assistant", content: "Done." },
      ],
      meta,
    );
    expect(md).toContain("# RevCode session s1");
    expect(md).toContain("- Model: glm-5.2 (zai)");
    expect(md).not.toContain("SECRET SYSTEM PROMPT");
    expect(md).toContain("## You\n\nfix it");
    expect(md).toContain("## RevCode\n\nOn it.");
    expect(md).toContain("**Tool:** `read_file`");
    expect(md).toContain('"path": "a.ts"');
    expect(md).toContain("<summary>Result</summary>");
    expect(md).toContain("Done.");
  });

  it("uses a longer fence when the content contains backticks and truncates huge results", () => {
    const md = conversationToMarkdown(
      [{ role: "tool", toolCallId: "1", name: "shell", content: JSON.stringify({ result: `\`\`\`\n${"y".repeat(5000)}` }) }],
      meta,
    );
    expect(md).toContain("````");
    expect(md).toContain("more characters)");
  });

  it("shows harness notes as quotes", () => {
    expect(conversationToMarkdown([{ role: "user", content: "[harness] rewound" }], meta)).toContain("> [harness] rewound");
  });
});
