import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverClaudeProjectCommands,
  discoverClaudeProjectSlashCommands,
} from "./ClaudeCommands.ts";

const writeCommand = Effect.fn(function* (
  workspace: string,
  relativePath: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(workspace, ".claude", "commands", relativePath);
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("discoverClaudeProjectSlashCommands", (it) => {
  it.effect("discovers commands with frontmatter metadata, sorted by name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-commands-" });
      const workspace = path.join(tempDir, "workspace");

      yield* writeCommand(
        workspace,
        "review.md",
        [
          "---",
          "description: Review the current diff.",
          "argument-hint: '[pr-number]'",
          "---",
          "",
          "Review it.",
        ].join("\n"),
      );
      yield* writeCommand(workspace, "deploy.md", "Deploy the app to staging.\n\nMore prompt.");

      const commands = yield* discoverClaudeProjectSlashCommands(workspace);

      assert.deepEqual(commands, [
        { name: "deploy", description: "Deploy the app to staging." },
        {
          name: "review",
          description: "Review the current diff.",
          input: { hint: "[pr-number]" },
        },
      ]);
    }),
  );

  it.effect("namespaces nested commands by their subdirectory path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-commands-" });
      const workspace = path.join(tempDir, "workspace");

      yield* writeCommand(workspace, "frontend/component.md", "Scaffold a component.");
      yield* writeCommand(workspace, "backend/component.md", "Scaffold a backend module.");
      yield* writeCommand(workspace, "notes.txt", "Not a command.");

      const commands = yield* discoverClaudeProjectSlashCommands(workspace);

      assert.deepEqual(commands, [
        { name: "backend:component", description: "Scaffold a backend module." },
        { name: "frontend:component", description: "Scaffold a component." },
      ]);
    }),
  );

  it.effect("falls back to the prompt's first line when frontmatter is empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-commands-" });
      const workspace = path.join(tempDir, "workspace");

      yield* writeCommand(workspace, "ship.md", ["---", "---", "", "Ship it safely."].join("\n"));

      const commands = yield* discoverClaudeProjectSlashCommands(workspace);

      assert.deepEqual(commands, [{ name: "ship", description: "Ship it safely." }]);
    }),
  );

  it.effect("still surfaces a command whose frontmatter is malformed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-commands-" });
      const workspace = path.join(tempDir, "workspace");

      yield* writeCommand(
        workspace,
        "broken.md",
        ["---", "description: [unterminated", "---", "", "Run the broken thing."].join("\n"),
      );

      const commands = yield* discoverClaudeProjectSlashCommands(workspace);

      assert.deepEqual(commands, [{ name: "broken", description: "Run the broken thing." }]);
    }),
  );

  it.effect("returns empty for a workspace without a commands directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-commands-" });

      const commands = yield* discoverClaudeProjectSlashCommands(path.join(tempDir, "missing"));

      assert.deepEqual(commands, []);
    }),
  );
});

it.layer(NodeServices.layer)("discoverClaudeProjectCommands", (it) => {
  it.effect("bundles project commands with project-scope skills only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-commands-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeCommand(workspace, "deploy.md", "Deploy the app.");
      const userSkillDir = path.join(configDir, "skills", "user-skill");
      yield* fs.makeDirectory(userSkillDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(userSkillDir, "SKILL.md"),
        ["---", "name: user-skill", "---"].join("\n"),
      );
      const projectSkillDir = path.join(workspace, ".claude", "skills", "repo-skill");
      yield* fs.makeDirectory(projectSkillDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(projectSkillDir, "SKILL.md"),
        ["---", "name: repo-skill", "description: Repo skill.", "---"].join("\n"),
      );

      const result = yield* discoverClaudeProjectCommands({ homePath: configDir }, workspace);

      assert.deepEqual(result, {
        slashCommands: [{ name: "deploy", description: "Deploy the app." }],
        // The user-scope skill is omitted: the environment snapshot already
        // carries it.
        skills: [
          {
            name: "repo-skill",
            path: path.join(projectSkillDir, "SKILL.md"),
            enabled: true,
            scope: "project",
            description: "Repo skill.",
          },
        ],
      });
    }),
  );
});
