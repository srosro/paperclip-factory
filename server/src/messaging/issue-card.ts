export interface IssueCardInput {
  identifier: string;
  title: string;
  status: string;
  assigneeDisplay?: string;
  priority?: string;
  projectName?: string;
  descriptionExcerpt?: string;
  issueUrl: string;
}

// Backend-agnostic fallback text. Adapters can emit richer Block Kit alongside.
export function fallbackCardText(input: IssueCardInput): string {
  const lines: string[] = [];
  lines.push(`[${input.identifier}] ${input.title}`);
  const contextParts = [
    input.status,
    input.assigneeDisplay ? `assignee ${input.assigneeDisplay}` : null,
    input.priority ? `priority ${input.priority}` : null,
  ].filter(Boolean) as string[];
  if (contextParts.length) lines.push(contextParts.join("  ·  "));
  if (input.projectName) lines.push(`project ${input.projectName}`);
  if (input.descriptionExcerpt) lines.push("", input.descriptionExcerpt);
  lines.push("", input.issueUrl);
  return lines.join("\n");
}
