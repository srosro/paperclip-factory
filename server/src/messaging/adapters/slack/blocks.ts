import type { IssueCardInput } from "../../issue-card.js";

/**
 * Block Kit payload for the thread parent ("issue card"). Posted by the bot,
 * edited in place on state changes.
 */
export function issueCardBlocks(input: IssueCardInput): unknown[] {
  const contextElements: unknown[] = [];
  if (input.status) {
    contextElements.push({ type: "mrkdwn", text: `*${input.status}*` });
  }
  if (input.assigneeDisplay) {
    contextElements.push({
      type: "mrkdwn",
      text: `assignee ${input.assigneeDisplay}`,
    });
  }
  if (input.priority) {
    contextElements.push({ type: "mrkdwn", text: `priority ${input.priority}` });
  }

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `[${input.identifier}] ${input.title}`.slice(0, 150),
      },
    },
  ];
  if (contextElements.length > 0) {
    blocks.push({ type: "context", elements: contextElements });
  }
  if (input.descriptionExcerpt) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: input.descriptionExcerpt.slice(0, 3000) },
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Open in Paperclip" },
        url: input.issueUrl,
      },
    ],
  });
  return blocks;
}
