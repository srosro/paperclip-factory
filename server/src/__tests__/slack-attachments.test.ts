import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  assets,
  companies,
  createDb,
  issueAttachments,
  issues,
  messagingChannels,
  messagingIdentities,
  messagingMessageRefs,
  messagingThreads,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Intercept the Slack web-api WebClient so outbound tests never hit Slack.
const filesUploadV2 = vi.fn<(args: unknown) => Promise<unknown>>();
const chatPostMessage = vi.fn<(args: unknown) => Promise<unknown>>();

vi.mock("@slack/web-api", () => {
  class WebClient {
    chat = { postMessage: chatPostMessage };
    files = { uploadV2: filesUploadV2 };
    conversations = {};
    users = {};
  }
  return { WebClient };
});

// Import AFTER vi.mock so the mocked WebClient is used.
const { createSlackAdapter } = await import("../messaging/adapters/slack/adapter.js");
const { createSlackFileIngest } = await import("../messaging/adapters/slack/file-ingest.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("slack adapter: outbound attachment upload", () => {
  beforeEach(() => {
    chatPostMessage.mockReset();
    filesUploadV2.mockReset();
  });

  it("posts the comment, uploads each attachment to the same thread, and returns file ids", async () => {
    chatPostMessage.mockResolvedValue({ ok: true, ts: "1717000000.000100" });
    filesUploadV2
      .mockResolvedValueOnce({ ok: true, files: [{ id: "F_UP_1" }] })
      .mockResolvedValueOnce({ ok: true, files: [{ id: "F_UP_2" }] });

    const fetchedIds: string[] = [];
    const adapter = createSlackAdapter({
      async getBotToken() {
        return "xoxb-test";
      },
      async getUserToken() {
        return "xoxp-test";
      },
      companyId: "c_test",
      async getAttachmentBytes(_companyId, attachmentId) {
        fetchedIds.push(attachmentId);
        return Buffer.from(`bytes-${attachmentId}`);
      },
    });

    const result = await adapter.postMessage({
      channelRef: "C_123",
      threadRef: "1716999999.000000",
      authorIdentity: {
        backend: "slack",
        externalUserRef: "U_AGENT",
        credential: { kind: "bot_token" },
      },
      body: "hello with files",
      attachments: [
        {
          paperclipAttachmentId: "att-1",
          filename: "a.png",
          contentType: "image/png",
          sizeBytes: 10,
        },
        {
          paperclipAttachmentId: "att-2",
          filename: "b.txt",
          contentType: "text/plain",
          sizeBytes: 20,
        },
      ],
    });

    expect(chatPostMessage).toHaveBeenCalledTimes(1);
    expect(chatPostMessage.mock.calls[0]![0]).toMatchObject({
      channel: "C_123",
      thread_ts: "1716999999.000000",
      text: "hello with files",
    });

    expect(filesUploadV2).toHaveBeenCalledTimes(2);
    expect(filesUploadV2.mock.calls[0]![0]).toMatchObject({
      channel_id: "C_123",
      thread_ts: "1716999999.000000",
      filename: "a.png",
    });
    expect(filesUploadV2.mock.calls[1]![0]).toMatchObject({
      channel_id: "C_123",
      thread_ts: "1716999999.000000",
      filename: "b.txt",
    });
    expect(fetchedIds).toEqual(["att-1", "att-2"]);
    expect(result.messageRef).toBe("1717000000.000100");
    expect(result.slackFileIds).toEqual(["F_UP_1", "F_UP_2"]);
  });

  it("uploadAttachmentToThread posts a single file and returns its Slack id", async () => {
    filesUploadV2.mockResolvedValueOnce({ ok: true, files: [{ id: "F_ONE" }] });

    const adapter = createSlackAdapter({
      async getBotToken() {
        return "xoxb-test";
      },
      async getUserToken() {
        return "xoxp-test";
      },
      companyId: "c_test",
    });

    const res = await adapter.uploadAttachmentToThread!({
      channelRef: "C_9",
      threadRef: "1.1",
      by: {
        backend: "slack",
        externalUserRef: "U_AGENT",
        credential: { kind: "bot_token" },
      },
      filename: "report.pdf",
      contentType: "application/pdf",
      body: Buffer.from("PDFBYTES"),
    });

    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    expect(filesUploadV2.mock.calls[0]![0]).toMatchObject({
      channel_id: "C_9",
      thread_ts: "1.1",
      filename: "report.pdf",
    });
    expect(res.slackFileId).toBe("F_ONE");
  });
});

describeIf("slack adapter: inbound file ingest", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-slack-attachments-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(messagingMessageRefs);
    await db.delete(messagingThreads);
    await db.delete(messagingChannels);
    await db.delete(messagingIdentities);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "AttachCo",
      issuePrefix: `AT${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    });
    const [project] = await db
      .insert(projects)
      .values({ companyId, name: "P" })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        projectId: project!.id,
        title: "attach-test",
        identifier: "AT-1",
      })
      .returning();
    const [channel] = await db
      .insert(messagingChannels)
      .values({
        companyId,
        backend: "slack",
        purpose: "project",
        projectId: project!.id,
        externalChannelRef: "C_ATTACH",
        externalChannelName: "proj-attach",
      })
      .returning();
    const [thread] = await db
      .insert(messagingThreads)
      .values({
        issueId: issue!.id,
        channelId: channel!.id,
        backend: "slack",
        externalThreadRef: "1.0",
        parentMessageRef: "1.0",
      })
      .returning();
    const [ref] = await db
      .insert(messagingMessageRefs)
      .values({
        threadId: thread!.id,
        backend: "slack",
        externalMessageRef: "1.1",
      })
      .returning();
    return { companyId, issueId: issue!.id, refId: ref!.id };
  }

  it("downloads each file, stores bytes, and creates an issue_attachments row", async () => {
    const { companyId, issueId, refId } = await seed();

    const fetchedUrls: string[] = [];
    const storedBodies: Buffer[] = [];

    const fakeStorage = {
      provider: "local_disk" as const,
      async putFile(input: {
        companyId: string;
        namespace: string;
        originalFilename: string | null;
        contentType: string;
        body: Buffer;
      }) {
        storedBodies.push(input.body);
        return {
          provider: "local_disk" as const,
          objectKey: `obj-${storedBodies.length}`,
          contentType: input.contentType,
          byteSize: input.body.length,
          sha256: "sha-" + storedBodies.length,
          originalFilename: input.originalFilename,
        };
      },
      async getObject() {
        throw new Error("not used");
      },
      async headObject() {
        throw new Error("not used");
      },
      async deleteObject() {
        // no-op
      },
    };

    const ingest = createSlackFileIngest({
      db,
      storage: fakeStorage,
      async fetchFile(urlPrivate) {
        fetchedUrls.push(urlPrivate);
        return {
          body: Buffer.from(`payload-${urlPrivate}`),
          contentType: "application/octet-stream",
        };
      },
      async resolveUserToken() {
        return "xoxp-user";
      },
    });

    await ingest({
      companyId,
      issueId,
      refId,
      authorExternalRef: "U_AUTHOR",
      files: [
        {
          id: "F1",
          name: "a.png",
          mimetype: "image/png",
          urlPrivate: "https://files.slack.com/a.png",
          size: 10,
        },
        {
          id: "F2",
          name: "b.pdf",
          mimetype: "application/pdf",
          urlPrivate: "https://files.slack.com/b.pdf",
          size: 20,
        },
      ],
    });

    expect(fetchedUrls).toEqual([
      "https://files.slack.com/a.png",
      "https://files.slack.com/b.pdf",
    ]);
    expect(storedBodies).toHaveLength(2);

    const rows = await db
      .select()
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, issueId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.messagingMessageRefId === refId)).toBe(true);

    const assetIds = rows.map((r) => r.assetId);
    const assetRows = await db.select().from(assets);
    expect(assetRows.map((a) => a.id).sort()).toEqual(assetIds.sort());
  });

  it("logs and continues when a single file download fails", async () => {
    const { companyId, issueId, refId } = await seed();

    const fakeStorage = {
      provider: "local_disk" as const,
      async putFile(input: {
        contentType: string;
        body: Buffer;
        originalFilename: string | null;
      }) {
        return {
          provider: "local_disk" as const,
          objectKey: `ok-1`,
          contentType: input.contentType,
          byteSize: input.body.length,
          sha256: "sha",
          originalFilename: input.originalFilename,
        };
      },
      async getObject() {
        throw new Error("not used");
      },
      async headObject() {
        throw new Error("not used");
      },
      async deleteObject() {
        // no-op
      },
    };

    const ingest = createSlackFileIngest({
      db,
      storage: fakeStorage,
      async fetchFile(urlPrivate) {
        if (urlPrivate.endsWith("bad")) return null;
        return { body: Buffer.from("ok"), contentType: "text/plain" };
      },
      async resolveUserToken() {
        return "xoxp-user";
      },
    });

    await ingest({
      companyId,
      issueId,
      refId,
      authorExternalRef: "U_AUTHOR",
      files: [
        {
          id: "F_bad",
          name: "bad.bin",
          mimetype: "application/octet-stream",
          urlPrivate: "https://files.slack.com/bad",
          size: 1,
        },
        {
          id: "F_ok",
          name: "ok.txt",
          mimetype: "text/plain",
          urlPrivate: "https://files.slack.com/ok",
          size: 2,
        },
      ],
    });

    const rows = await db
      .select()
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, issueId));
    expect(rows).toHaveLength(1);
  });
});
