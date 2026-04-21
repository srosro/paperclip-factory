/** Minimal set of GraphQL operation strings for the Linear adapter. */

export const QUERY_VIEWER = `
  query Viewer {
    viewer { id name email }
  }
`;

export const QUERY_TEAM_WORKFLOW_STATES = `
  query TeamWorkflowStates($teamId: String!) {
    team(id: $teamId) {
      id
      key
      states { nodes { id name type } }
    }
  }
`;

export const QUERY_TEAMS = `
  query Teams { teams { nodes { id key name } } }
`;

export const MUTATION_TEAM_CREATE = `
  mutation TeamCreate($input: TeamCreateInput!) {
    teamCreate(input: $input) {
      success
      team { id key name }
    }
  }
`;

export const MUTATION_ISSUE_CREATE = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id identifier title description priority
        state { id name type }
        assignee { id name email }
        labels { nodes { id name color } }
        project { id name }
        team { id key }
        createdAt updatedAt
      }
    }
  }
`;

export const MUTATION_ISSUE_UPDATE = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id identifier title description priority
        state { id name type }
        assignee { id name email }
        labels { nodes { id name color } }
        project { id name }
        team { id key }
        createdAt updatedAt
      }
    }
  }
`;

export const QUERY_ISSUE = `
  query Issue($id: String!) {
    issue(id: $id) {
      id identifier title description priority
      state { id name type }
      assignee { id name email }
      labels { nodes { id name color } }
      project { id name }
      team { id key }
      createdAt updatedAt archivedAt
    }
  }
`;

export const MUTATION_ISSUE_ARCHIVE = `
  mutation IssueArchive($id: String!) {
    issueArchive(id: $id) { success }
  }
`;

export const MUTATION_COMMENT_CREATE = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id body createdAt updatedAt editedAt
        user { id name }
        issue { id identifier }
      }
    }
  }
`;

export const MUTATION_COMMENT_UPDATE = `
  mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
    commentUpdate(id: $id, input: $input) { success }
  }
`;

export const MUTATION_COMMENT_DELETE = `
  mutation CommentDelete($id: String!) {
    commentDelete(id: $id) { success }
  }
`;

export const QUERY_COMMENTS = `
  query Comments($issueId: String!, $first: Int!, $after: String) {
    issue(id: $issueId) {
      comments(first: $first, after: $after) {
        nodes {
          id body createdAt updatedAt editedAt
          user { id name }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const QUERY_COMMENT = `
  query Comment($id: String!) {
    comment(id: $id) {
      id body createdAt updatedAt editedAt
      user { id name }
      issue { id identifier }
    }
  }
`;

export const QUERY_TEAM_LABELS = `
  query TeamLabels($teamId: String!) {
    team(id: $teamId) {
      labels { nodes { id name color } }
    }
  }
`;

export const MUTATION_ISSUE_LABEL_CREATE = `
  mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      success
      issueLabel { id name color }
    }
  }
`;

export const MUTATION_USER_INVITE = `
  mutation OrganizationInviteCreate($input: OrganizationInviteCreateInput!) {
    organizationInviteCreate(input: $input) {
      success
      organizationInvite { id email }
    }
  }
`;

export const MUTATION_WEBHOOK_CREATE = `
  mutation WebhookCreate($input: WebhookCreateInput!) {
    webhookCreate(input: $input) {
      success
      webhook { id secret resourceTypes }
    }
  }
`;

export const MUTATION_ATTACHMENT_CREATE = `
  mutation AttachmentCreate($input: AttachmentCreateInput!) {
    attachmentCreate(input: $input) {
      success
      attachment { id title url }
    }
  }
`;

export const QUERY_ISSUES = `
  query Issues($filter: IssueFilter, $first: Int, $after: String) {
    issues(
      filter: $filter
      first: $first
      after: $after
      orderBy: updatedAt
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        team { id key }
        state { id name type }
        assignee { id name email }
        labels { nodes { id name color } }
        createdAt
        updatedAt
      }
    }
  }
`;

export const QUERY_ISSUE_SEARCH = `
  query IssueSearch($filter: IssueFilter, $query: String!, $first: Int) {
    issueSearch(
      query: $query
      filter: $filter
      first: $first
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        team { id key }
        state { id name type }
        assignee { id name email }
        labels { nodes { id name color } }
        createdAt
        updatedAt
      }
    }
  }
`;

export const QUERY_ISSUE_BY_IDENTIFIER = `
  query IssueByIdentifier($identifier: String!) {
    issueByIdentifier(identifier: $identifier) {
      id
      identifier
      title
      description
      priority
      team { id key }
      state { id name type }
      assignee { id name email }
      labels { nodes { id name color } }
      createdAt
      updatedAt
    }
  }
`;
