/**
 * Tool: write content to a file.
 *
 * TODO: implement. Should create parent directories, show a diff
 *       before writing, and respect sandbox boundaries.
 */

export interface WriteToolInput {
  path: string;
  content: string;
}

export async function writeFile(_input: WriteToolInput): Promise<void> {
  throw new Error("write tool not yet implemented");
}
