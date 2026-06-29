/**
 * Diff utilities.
 */

export function generateDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  if (oldContent === newContent) {
    return "";
  }

  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const oldHeader = `--- a/${filePath}`;
  const newHeader = `+++ b/${filePath}`;
  const hunkHeader = `@@ -1,${oldLines.length} +1,${newLines.length} @@`;
  const oldBody = oldLines.map((line) => `-${line}`);
  const newBody = newLines.map((line) => `+${line}`);

  return [oldHeader, newHeader, hunkHeader, ...oldBody, ...newBody].join("\n");
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}
