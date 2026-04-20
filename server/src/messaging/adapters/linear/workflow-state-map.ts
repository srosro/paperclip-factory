export type PaperclipStatus =
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";
}

export type WorkflowStateMap =
  | {
      kind: "complete";
      byStatus: Record<PaperclipStatus, string>;
    }
  | {
      kind: "incomplete";
      missing: PaperclipStatus[];
      partial: Partial<Record<PaperclipStatus, string>>;
    };

export function resolveWorkflowStateMap(
  states: LinearWorkflowState[],
): WorkflowStateMap {
  const byType = new Map<string, LinearWorkflowState[]>();
  for (const s of states) {
    const arr = byType.get(s.type) ?? [];
    arr.push(s);
    byType.set(s.type, arr);
  }

  const preferName = (arr: LinearWorkflowState[], name: string) =>
    arr.find((s) => s.name.toLowerCase() === name.toLowerCase());

  const started = byType.get("started") ?? [];
  const partial: Partial<Record<PaperclipStatus, string>> = {};

  const unstarted = byType.get("unstarted")?.[0];
  if (unstarted) partial.todo = unstarted.id;

  const inProgress = preferName(started, "In Progress") ?? started[0];
  if (inProgress) partial.in_progress = inProgress.id;

  const inReview = preferName(started, "In Review");
  if (inReview) partial.in_review = inReview.id;
  else if (inProgress) partial.in_review = inProgress.id;

  const blocked = preferName(started, "Blocked");
  if (blocked) partial.blocked = blocked.id;
  else if (inProgress) partial.blocked = inProgress.id;

  const completed = byType.get("completed")?.[0];
  if (completed) partial.done = completed.id;

  const canceled = byType.get("canceled")?.[0];
  if (canceled) partial.cancelled = canceled.id;

  const required: PaperclipStatus[] = [
    "todo",
    "in_progress",
    "in_review",
    "blocked",
    "done",
    "cancelled",
  ];
  const missing = required.filter((s) => !(s in partial));
  if (missing.length > 0) {
    return { kind: "incomplete", missing, partial };
  }
  return {
    kind: "complete",
    byStatus: partial as Record<PaperclipStatus, string>,
  };
}

export function mapPaperclipStatusToLinearStateId(
  map: WorkflowStateMap,
  status: PaperclipStatus,
): string {
  if (map.kind !== "complete") {
    throw new Error(
      `workflow state map is incomplete; cannot map status ${status}`,
    );
  }
  return map.byStatus[status];
}

export function mapPaperclipPriorityToLinearPriority(
  priority: "critical" | "high" | "medium" | "low" | null | undefined,
): number {
  switch (priority) {
    case "critical":
      return 1;
    case "high":
      return 2;
    case "medium":
      return 3;
    case "low":
      return 4;
    default:
      return 0;
  }
}

export function mapLinearStateTypeToPaperclipStatus(
  stateType: LinearWorkflowState["type"],
): PaperclipStatus | null {
  switch (stateType) {
    case "unstarted":
    case "backlog":
    case "triage":
      return "todo";
    case "started":
      return "in_progress";
    case "completed":
      return "done";
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * Returns a map from Linear state ID → PaperclipStatus, built by inverting
 * the complete workflow state map. Returns an empty map if the map is incomplete.
 */
export function invertWorkflowStateMap(
  map: WorkflowStateMap,
): Record<string, PaperclipStatus> {
  if (map.kind !== "complete") return {};
  const out: Record<string, PaperclipStatus> = {};
  for (const [status, stateId] of Object.entries(map.byStatus) as [PaperclipStatus, string][]) {
    out[stateId] = status;
  }
  return out;
}

/**
 * Maps a Linear numeric priority (1=urgent, 2=high, 3=medium, 4=low, 0=no priority)
 * to a Paperclip priority string.
 */
export function mapLinearPriorityToPaperclip(
  priority: number,
): "critical" | "high" | "medium" | "low" | null {
  switch (priority) {
    case 1: return "critical";
    case 2: return "high";
    case 3: return "medium";
    case 4: return "low";
    default: return null;
  }
}
