/** Apply a bounded single-file unified diff. */
export function applyWorkspaceUnifiedPatch(
  content: string,
  patch: string,
  path: string,
): { content: string; hunkCount: number } {
  const source = content.split("\n");
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  const output: string[] = [];
  let sourceIndex = 0;
  let lineIndex = 0;
  let hunkCount = 0;

  while (lineIndex < lines.length && !lines[lineIndex]!.startsWith("@@")) {
    lineIndex += 1;
  }
  while (lineIndex < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
      lines[lineIndex]!,
    );
    if (!header) {
      if (lines[lineIndex] === "") break;
      throw new Error(`Invalid unified patch hunk for ${path}`);
    }
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2] ?? "1");
    const newCount = Number(header[4] ?? "1");
    const targetIndex = oldStart === 0 ? 0 : oldStart - 1;
    if (targetIndex < sourceIndex || targetIndex > source.length) {
      throw new Error(`Patch hunk is outside ${path}`);
    }
    output.push(...source.slice(sourceIndex, targetIndex));
    sourceIndex = targetIndex;
    lineIndex += 1;
    let removed = 0;
    let added = 0;

    while (lineIndex < lines.length && !lines[lineIndex]!.startsWith("@@")) {
      const line = lines[lineIndex]!;
      if (line === "\\ No newline at end of file") {
        lineIndex += 1;
        continue;
      }
      if (line === "" && lineIndex === lines.length - 1) {
        lineIndex += 1;
        break;
      }
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        if (source[sourceIndex] !== text) {
          throw new Error(`Patch context did not match ${path}`);
        }
        output.push(text);
        sourceIndex += 1;
        removed += 1;
        added += 1;
      } else if (marker === "-") {
        if (source[sourceIndex] !== text) {
          throw new Error(`Patch removal did not match ${path}`);
        }
        sourceIndex += 1;
        removed += 1;
      } else if (marker === "+") {
        output.push(text);
        added += 1;
      } else {
        throw new Error(`Invalid unified patch line for ${path}`);
      }
      lineIndex += 1;
    }
    if (removed !== oldCount || added !== newCount) {
      throw new Error(`Patch hunk counts did not match ${path}`);
    }
    hunkCount += 1;
  }
  if (hunkCount === 0) throw new Error(`Patch contains no hunks for ${path}`);
  output.push(...source.slice(sourceIndex));
  return { content: output.join("\n"), hunkCount };
}
