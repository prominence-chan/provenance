// The platform in a few words, for prompts (kept apart from backend.ts so that prompts.ts needs
// nothing of the backend).

export function platformLabel(): string {
  return process.platform === "darwin"
    ? "macOS, zsh"
    : process.platform === "win32"
      ? "Windows"
      : "Linux, sh";
}
