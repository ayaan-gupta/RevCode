import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../llm/client.js";
import { applySchemaStyle, trimSentences } from "./schema-style.js";

const def: ToolDefinition = {
  name: "t",
  description: `First sentence. ${"Second sentence that keeps going on and on. ".repeat(8)}Third sentence.`,
  parameters: {
    type: "object",
    properties: {
      optional: { type: "integer", minimum: 1, description: "An optional thing." },
      needed: { type: "string", description: "Needed." },
    },
    required: ["needed"],
    additionalProperties: false,
  },
};

describe("schema style", () => {
  it("full leaves definitions untouched", () => {
    expect(applySchemaStyle([def], "full")[0]).toBe(def);
  });

  it("flat puts required first, trims descriptions, drops validation noise", () => {
    const [flat] = applySchemaStyle([def], "flat");
    const props = Object.keys((flat.parameters as { properties: object }).properties);
    expect(props).toEqual(["needed", "optional"]);
    expect(flat.description.length).toBeLessThan(def.description.length);
    expect(flat.description.startsWith("First sentence.")).toBe(true);
    expect(JSON.stringify(flat.parameters)).not.toContain("additionalProperties");
    expect(JSON.stringify(flat.parameters)).not.toContain("minimum");
    expect((flat.parameters as { required: string[] }).required).toEqual(["needed"]);
  });

  it("trimSentences keeps whole sentences within budget", () => {
    expect(trimSentences("A. B. C.", 4)).toBe("A.");
    expect(trimSentences("short", 50)).toBe("short");
  });
});
