import { and, eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { createDb, messagingLabelRefs, labels, companies } from "@paperclipai/db";
import {
  startEmbeddedPostgresTestDatabase,
  getEmbeddedPostgresTestSupport,
} from "./helpers/embedded-postgres.js";
import { ensureLinearLabelRef } from "../messaging/adapters/linear/label-sync.js";

const support = await getEmbeddedPostgresTestSupport();
const describeIf = support.supported ? describe : describe.skip;

describeIf("linear label sync", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let labelId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-linear-label-sync-");
    db = createDb(tempDb.connectionString);
    const [co] = await db
      .insert(companies)
      .values({ name: "X", issuePrefix: "XX" })
      .returning();
    companyId = co!.id;
    const [l] = await db
      .insert(labels)
      .values({ companyId, name: "bug", color: "#f00" })
      .returning();
    labelId = l!.id;
  }, 30_000);

  afterEach(async () => {
    await db.delete(messagingLabelRefs);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns existing ref when label was already synced", async () => {
    await db.insert(messagingLabelRefs).values({
      companyId,
      backend: "linear",
      paperclipLabelId: labelId,
      externalLabelRef: "L_1",
    });
    const ref = await ensureLinearLabelRef(
      { db, companyId, paperclipLabelId: labelId },
      async () => {
        throw new Error("should not be called when a ref already exists");
      },
    );
    expect(ref).toBe("L_1");
  });

  it("creates a new ref via the remote-create callback", async () => {
    const ref = await ensureLinearLabelRef(
      { db, companyId, paperclipLabelId: labelId },
      async () => "L_new",
    );
    expect(ref).toBe("L_new");
    const [row] = await db
      .select()
      .from(messagingLabelRefs)
      .where(
        and(
          eq(messagingLabelRefs.paperclipLabelId, labelId),
          eq(messagingLabelRefs.backend, "linear"),
        ),
      );
    expect(row!.externalLabelRef).toBe("L_new");
  });
});
