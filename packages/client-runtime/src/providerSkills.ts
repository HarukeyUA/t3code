import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu ? skills.filter((skill) => skill.enabled) : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

/**
 * Layer workspace-scoped slash commands (from `providers.getProjectCommands`)
 * over the environment-scoped snapshot list. Project entries replace
 * same-named environment entries in place; new ones append after them.
 */
export function mergeProviderSlashCommands(
  environment: ReadonlyArray<ServerProviderSlashCommand>,
  project: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  if (project.length === 0) {
    return environment;
  }
  const projectByName = new Map(project.map((command) => [command.name.toLowerCase(), command]));
  const merged = environment.map(
    (command) => projectByName.get(command.name.toLowerCase()) ?? command,
  );
  const environmentNames = new Set(environment.map((command) => command.name.toLowerCase()));
  for (const command of project) {
    if (!environmentNames.has(command.name.toLowerCase())) {
      merged.push(command);
    }
  }
  return merged;
}

/**
 * Layer workspace-scoped skills over the environment-scoped snapshot list.
 * Same replace-in-place semantics as `mergeProviderSlashCommands`, keyed by
 * exact skill name to match the server's collision rules.
 */
export function mergeProviderSkills(
  environment: ReadonlyArray<ServerProviderSkill>,
  project: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  if (project.length === 0) {
    return environment;
  }
  const projectByName = new Map(project.map((skill) => [skill.name, skill]));
  const merged = environment.map((skill) => projectByName.get(skill.name) ?? skill);
  const environmentNames = new Set(environment.map((skill) => skill.name));
  for (const skill of project) {
    if (!environmentNames.has(skill.name)) {
      merged.push(skill);
    }
  }
  return merged;
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}
