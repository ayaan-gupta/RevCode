/**
 * Tool: read a file from the working directory.
 *
 * TODO: implement. Should return file content with line numbers,
 *       respect .gitignore, and handle binary files gracefully.
 */

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadToolOutput {
  content: string;
  path: string;
  totalLines: number;
}

export async function readFile(_input: ReadToolInput): Promise<ReadToolOutput> {
  throw new Error("read tool not yet implemented");
}
