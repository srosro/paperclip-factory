/** Shared GraphQL response shape from Linear. */
export interface LinearGraphQLResponse<T> {
  data: T | null;
  errors?: Array<{
    message: string;
    extensions?: Record<string, unknown>;
    path?: (string | number)[];
  }>;
}

export interface LinearWebhookEnvelope {
  action: "create" | "update" | "remove";
  type:
    | "Issue"
    | "Comment"
    | "IssueLabel"
    | "Reaction"
    | "Attachment"
    | "Project";
  data: Record<string, unknown>;
  url?: string;
  createdAt: string;
  actor?: { id: string; name?: string; type?: "user" | "oauth" };
  organizationId: string;
  webhookTimestamp: number;
  webhookId: string;
}

export interface LinearIssueRaw {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number;
  state?: { id: string; name: string; type: string } | null;
  assignee?: { id: string; name: string; email?: string } | null;
  labels?: { nodes: Array<{ id: string; name: string; color?: string | null }> };
  project?: { id: string; name: string } | null;
  team: { id: string; key: string };
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface LinearCommentRaw {
  id: string;
  body: string;
  user?: { id: string; name: string } | null;
  issue?: { id: string; identifier: string } | null;
  createdAt: string;
  updatedAt: string;
  editedAt?: string | null;
}
