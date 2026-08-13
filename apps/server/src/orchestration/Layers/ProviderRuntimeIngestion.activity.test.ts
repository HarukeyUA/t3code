import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });

  it("preserves timeline bypass on background task progress and usage", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-background-shell"),
      payload: {
        taskId: RuntimeTaskId.make("background-shell"),
        taskType: "local_bash",
        description: "Running tests",
        summary: "Running tests",
        typedUsage: { totalTokens: 8_400, toolUses: 3 },
        timelineBypass: true,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(2);
    for (const activity of activities) {
      expect(activity.payload).toMatchObject({
        taskType: "local_bash",
        agentKind: "background",
        timelineBypass: true,
      });
    }
  });
});
