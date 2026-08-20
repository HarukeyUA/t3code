import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderSkillDisplayName,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  mergeProviderSkills,
  mergeProviderSlashCommands,
  resolveProviderSkillSourceKind,
} from "./providerSkills.ts";

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("getProviderSkillsForSlashMenu", () => {
  it("keeps the skill alias when the provider also exposes it as a slash command", () => {
    const askMatt = {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    };
    expect(getProviderSkillsForSlashMenu([askMatt], true).map((skill) => skill.name)).toEqual([
      "ask-matt",
    ]);
  });
});

describe("getProviderSlashCommandsForSlashMenu", () => {
  const commands = [
    { name: "ask-matt", description: "Ask which skill fits your situation." },
    { name: "compact", description: "Compact the conversation." },
  ];
  const skills = [
    {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    },
  ];

  it("lets the skill alias win when a provider command has the same name", () => {
    expect(
      getProviderSlashCommandsForSlashMenu(commands, skills).map((command) => command.name),
    ).toEqual(["compact"]);
  });

  it("keeps the provider command when the matching skill alias is hidden", () => {
    const visibleSkills = getProviderSkillsForSlashMenu(skills, false);

    expect(
      getProviderSlashCommandsForSlashMenu(commands, visibleSkills).map((command) => command.name),
    ).toEqual(["ask-matt", "compact"]);
  });
});

describe("resolveProviderSkillSourceKind", () => {
  it("marks plugin-backed skills as app installs", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("app");
  });

  it("maps standard scopes to source kinds", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "repo",
      }),
    ).toBe("repo");
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("project");
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("personal");
    expect(
      resolveProviderSkillSourceKind({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("system");
  });

  it("keeps unknown and missing scopes usable", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
        scope: "team_shared",
      }),
    ).toBe("other");
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
      }),
    ).toBe("other");
  });
});

describe("mergeProviderSlashCommands", () => {
  it("returns the environment list unchanged when the project adds nothing", () => {
    const environment = [{ name: "compact" }];
    expect(mergeProviderSlashCommands(environment, [])).toBe(environment);
  });

  it("replaces same-named commands in place and appends new ones", () => {
    expect(
      mergeProviderSlashCommands(
        [{ name: "compact" }, { name: "review", description: "user review" }],
        [
          { name: "Review", description: "project review" },
          { name: "deploy", description: "project deploy" },
        ],
      ),
    ).toEqual([
      { name: "compact" },
      { name: "Review", description: "project review" },
      { name: "deploy", description: "project deploy" },
    ]);
  });
});

describe("mergeProviderSkills", () => {
  it("returns the environment list unchanged when the project adds nothing", () => {
    const environment = [{ name: "review", path: "/home/.claude/skills/review", enabled: true }];
    expect(mergeProviderSkills(environment, [])).toBe(environment);
  });

  it("replaces same-named skills in place and appends new ones", () => {
    expect(
      mergeProviderSkills(
        [
          { name: "review", path: "/home/.claude/skills/review", enabled: true, scope: "user" },
          { name: "docs", path: "/home/.claude/skills/docs", enabled: true, scope: "user" },
        ],
        [
          { name: "review", path: "/repo/.claude/skills/review", enabled: true, scope: "project" },
          { name: "deploy", path: "/repo/.claude/skills/deploy", enabled: true, scope: "project" },
        ],
      ),
    ).toEqual([
      { name: "review", path: "/repo/.claude/skills/review", enabled: true, scope: "project" },
      { name: "docs", path: "/home/.claude/skills/docs", enabled: true, scope: "user" },
      { name: "deploy", path: "/repo/.claude/skills/deploy", enabled: true, scope: "project" },
    ]);
  });
});
