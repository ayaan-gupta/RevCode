/**
 * Tool: apply a targeted edit to an existing file.
 *
 * TODO: implement. Should accept oldText/newText replacements,
 *       verify uniqueness, and return a unified diff.
 */

export interface EditToolInput {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

export async function editFile(_input: EditToolInput): Promise<string> {
  throw new Error("edit tool not yet implemented");
}
