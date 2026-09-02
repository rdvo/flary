export function workspacePathMatches(path: string, prefix: string, recursive: boolean): boolean {
  if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) return false;
  if (recursive) return true;
  const relative = prefix ? path.slice(prefix.length).replace(/^\//, "") : path;
  return !relative.includes("/");
}

export function decodeWorkspaceFileContent(
  content: string,
  encoding: "utf8" | "base64",
): Uint8Array {
  return encoding === "utf8" ? new TextEncoder().encode(content) : base64ToWorkspaceBytes(content);
}

export async function workspaceSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function workspaceBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToWorkspaceBytes(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error("File content is not valid base64");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
