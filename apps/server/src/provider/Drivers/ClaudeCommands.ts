/**
 * ClaudeCommands — filesystem discovery of project-local Claude Code slash
 * commands for the `/` picker.
 *
 * Claude Code loads project commands from `<cwd>/.claude/commands`, one
 * markdown file per command with optional YAML frontmatter (`description`,
 * `argument-hint`). Subdirectories namespace the command name with `:`
 * separators — `frontend/component.md` is `/frontend:component` — matching
 * what the Claude Code init handshake reports for the same tree. User-scope
 * and built-in commands are already reported by the Agent SDK init handshake
 * in the provider snapshot; this scan only covers the project scope the
 * snapshot's server-wide cwd cannot see.
 *
 * @module provider/Drivers/ClaudeCommands
 */
import type {
  ClaudeSettings,
  ProviderProjectCommandsResult,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeFrontmatterString,
  discoverClaudeSkills,
  parseClaudeMarkdownFrontmatter,
} from "./ClaudeSkills.ts";

/** Upper bound on surfaced commands so a pathological directory cannot bloat
    the wire payload; the picker never usefully shows anywhere near this many. */
const MAX_PROJECT_COMMANDS = 256;
const MAX_FALLBACK_DESCRIPTION_LENGTH = 120;

/** Claude Code defaults a command's description to its prompt's first line. */
function fallbackDescription(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    return trimmed.length > MAX_FALLBACK_DESCRIPTION_LENGTH
      ? `${trimmed.slice(0, MAX_FALLBACK_DESCRIPTION_LENGTH - 1)}…`
      : trimmed;
  }
  return undefined;
}

/**
 * Enumerate project-scope Claude Code slash commands under
 * `<cwd>/.claude/commands`. Discovery is best-effort: a missing root or an
 * unreadable file yields no entry rather than a failure, and a command with
 * broken frontmatter is still surfaced by name because Claude Code still
 * runs it. On duplicate names the first path in sorted order wins.
 */
export const discoverClaudeProjectSlashCommands = Effect.fn("discoverClaudeProjectSlashCommands")(
  function* (
    cwd: string,
  ): Effect.fn.Return<
    ReadonlyArray<ServerProviderSlashCommand>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(cwd, ".claude", "commands");

    const entries = yield* fileSystem
      .readDirectory(root, { recursive: true })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    const commandsByName = new Map<string, ServerProviderSlashCommand>();
    for (const entry of [...entries].sort()) {
      if (commandsByName.size >= MAX_PROJECT_COMMANDS) {
        break;
      }
      if (!entry.toLowerCase().endsWith(".md")) {
        continue;
      }

      // `readDirectory({ recursive: true })` yields platform-separated
      // relative paths; each directory level becomes a `:` namespace segment.
      const name = entry
        .replace(/\.md$/i, "")
        .split(/[\\/]/)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join(":");
      if (!name || commandsByName.has(name.toLowerCase())) {
        continue;
      }

      // Also skips directories that happen to be named `*.md`.
      const contents = yield* fileSystem
        .readFileString(path.join(root, entry))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseClaudeMarkdownFrontmatter(contents);
      const description =
        claudeFrontmatterString(frontmatter, "description") ??
        fallbackDescription(frontmatter.body);
      const argumentHint = claudeFrontmatterString(frontmatter, "argument-hint");
      commandsByName.set(name.toLowerCase(), {
        name,
        ...(description ? { description } : {}),
        ...(argumentHint ? { input: { hint: argumentHint } } : {}),
      });
    }

    return [...commandsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
  },
);

/**
 * Project-scope slash commands and skills for one workspace directory — the
 * `ProviderInstance.projectCommands` hook body. User-scope entries are
 * excluded because the environment snapshot already carries them.
 */
export const discoverClaudeProjectCommands = Effect.fn("discoverClaudeProjectCommands")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ProviderProjectCommandsResult, never, FileSystem.FileSystem | Path.Path> {
  const slashCommands = yield* discoverClaudeProjectSlashCommands(cwd);
  const skills = yield* discoverClaudeSkills(config, cwd, environment);
  return {
    slashCommands,
    skills: skills.filter((skill) => skill.scope === "project"),
  };
});
