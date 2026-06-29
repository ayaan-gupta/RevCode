import { describe, expect, it } from "vitest";
import { getSlashMenuCommands, SLASH_COMMANDS } from "./slash-commands.js";

describe("slash command menu", () => {
  it("lists all commands when only / is typed", () => {
    expect(getSlashMenuCommands("/")).toEqual([...SLASH_COMMANDS]);
  });

  it("filters commands by prefix", () => {
    const matches = getSlashMenuCommands("/m");
    expect(matches?.map((entry) => entry.command)).toEqual(["/memory", "/model"]);
  });

  it("hides the menu after a space", () => {
    expect(getSlashMenuCommands("/help please")).toBeUndefined();
  });

  it("hides the menu for non-slash input", () => {
    expect(getSlashMenuCommands("hello")).toBeUndefined();
  });

  it("returns undefined when no commands match", () => {
    expect(getSlashMenuCommands("/zzz")).toBeUndefined();
  });
});
