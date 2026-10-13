import { describe, expect, it } from "vitest";
import { getSlashMenuCommands, registerSlashCommands, SLASH_COMMANDS } from "./slash-commands.js";

describe("slash command menu", () => {
  it("lists all commands when only / is typed", () => {
    expect(getSlashMenuCommands("/")).toEqual(SLASH_COMMANDS.slice(0, 12));
  });

  it("filters commands by prefix", () => {
    const matches = getSlashMenuCommands("/m");
    expect(matches?.map((entry) => entry.command)).toEqual(["/model", "/mode", "/memory"]);
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

  it("includes dynamically registered commands (custom commands, skills)", () => {
    registerSlashCommands([{ command: "/review", description: "Review the diff" }]);
    expect(getSlashMenuCommands("/rev")?.map((e) => e.command)).toEqual(["/review", "/rewind", "/receipt"].filter((c) => c.startsWith("/rev")));
    registerSlashCommands([]);
  });
});
