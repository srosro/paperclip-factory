import { describe, expect, it } from "vitest";
import {
  mapPaperclipStatusToLinearStateId,
  mapPaperclipPriorityToLinearPriority,
  mapLinearStateTypeToPaperclipStatus,
  resolveWorkflowStateMap,
  type LinearWorkflowState,
} from "../messaging/adapters/linear/workflow-state-map.js";

const statesExample: LinearWorkflowState[] = [
  { id: "s_triage", name: "Triage", type: "triage" },
  { id: "s_backlog", name: "Backlog", type: "backlog" },
  { id: "s_todo", name: "Todo", type: "unstarted" },
  { id: "s_inprog", name: "In Progress", type: "started" },
  { id: "s_review", name: "In Review", type: "started" },
  { id: "s_blocked", name: "Blocked", type: "started" },
  { id: "s_done", name: "Done", type: "completed" },
  { id: "s_cancel", name: "Canceled", type: "canceled" },
];

describe("workflow-state mapping", () => {
  it("resolves each Paperclip status to a Linear state id", () => {
    const map = resolveWorkflowStateMap(statesExample);
    expect(map.kind).toBe("complete");
    if (map.kind !== "complete") return;
    expect(map.byStatus.todo).toBe("s_todo");
    expect(map.byStatus.in_progress).toBe("s_inprog");
    expect(map.byStatus.in_review).toBe("s_review");
    expect(map.byStatus.blocked).toBe("s_blocked");
    expect(map.byStatus.done).toBe("s_done");
    expect(map.byStatus.cancelled).toBe("s_cancel");
  });

  it("reports missing states when the workflow is incomplete", () => {
    const partial: LinearWorkflowState[] = [
      { id: "s_todo", name: "Todo", type: "unstarted" },
      { id: "s_done", name: "Done", type: "completed" },
    ];
    const map = resolveWorkflowStateMap(partial);
    expect(map.kind).toBe("incomplete");
    if (map.kind !== "incomplete") return;
    expect(map.missing).toContain("in_progress");
    expect(map.missing).toContain("cancelled");
  });

  it("maps status via resolved map", () => {
    const map = resolveWorkflowStateMap(statesExample);
    if (map.kind !== "complete") throw new Error("expected complete map");
    expect(mapPaperclipStatusToLinearStateId(map, "in_progress")).toBe("s_inprog");
  });

  it("maps Paperclip priority strings to Linear 0-4 ints", () => {
    expect(mapPaperclipPriorityToLinearPriority("critical")).toBe(1);
    expect(mapPaperclipPriorityToLinearPriority("high")).toBe(2);
    expect(mapPaperclipPriorityToLinearPriority("medium")).toBe(3);
    expect(mapPaperclipPriorityToLinearPriority("low")).toBe(4);
    expect(mapPaperclipPriorityToLinearPriority(null)).toBe(0);
    expect(mapPaperclipPriorityToLinearPriority(undefined)).toBe(0);
  });

  it("maps Linear state types back to Paperclip statuses", () => {
    expect(mapLinearStateTypeToPaperclipStatus("unstarted")).toBe("todo");
    expect(mapLinearStateTypeToPaperclipStatus("backlog")).toBe("todo");
    expect(mapLinearStateTypeToPaperclipStatus("triage")).toBe("todo");
    expect(mapLinearStateTypeToPaperclipStatus("started")).toBe("in_progress");
    expect(mapLinearStateTypeToPaperclipStatus("completed")).toBe("done");
    expect(mapLinearStateTypeToPaperclipStatus("canceled")).toBe("cancelled");
  });
});
