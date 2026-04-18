import { and, eq } from "drizzle-orm";
import {
  assets,
  issueAttachments,
  messagingIdentities,
} from "@paperclipai/db";
import type { IncomingFileRef } from "../../types.js";
import type { Db } from "../../router.js";
import type { StorageService } from "../../../storage/types.js";
import { secretService } from "../../../services/secrets.js";

export interface SlackFileIngestDeps {
  db: Db;
  storage: StorageService;
  /**
   * Downloader for Slack file bytes. Factored out so tests can stub the
   * HTTP call without mocking fetch globals. The default implementation
   * uses the runtime fetch.
   */
  fetchFile?: (
    urlPrivate: string,
    token: string,
  ) => Promise<{ body: Buffer; contentType: string } | null>;
  /**
   * Resolve a Slack user token by the author's external Slack user id. The
   * default implementation reads the user's messaging_identities row and
   * decrypts the associated company secret. Exposed so tests can short-
   * circuit the lookup.
   */
  resolveUserToken?: (
    companyId: string,
    externalUserRef: string,
  ) => Promise<string | null>;
}

async function defaultFetchFile(
  urlPrivate: string,
  token: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const res = await fetch(urlPrivate, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { body: buf, contentType };
}

async function defaultResolveUserToken(
  db: Db,
  companyId: string,
  externalUserRef: string,
): Promise<string | null> {
  const [identity] = await db
    .select()
    .from(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.companyId, companyId),
        eq(messagingIdentities.backend, "slack"),
        eq(messagingIdentities.externalUserRef, externalUserRef),
      ),
    )
    .limit(1);
  if (!identity || !identity.authBlobSecretId) return null;
  if (identity.state !== "active") return null;
  const secrets = secretService(db);
  return secrets.resolveSecretValue(companyId, identity.authBlobSecretId, "latest");
}

/**
 * Download Slack file bytes for each incoming file, register them as
 * Paperclip assets, and insert issue_attachments rows pointing back to the
 * messaging message ref. Per-file failures are logged and swallowed so
 * partial ingest is preserved.
 */
export function createSlackFileIngest(deps: SlackFileIngestDeps) {
  const fetchFile = deps.fetchFile ?? defaultFetchFile;
  const resolveUserToken =
    deps.resolveUserToken ??
    ((companyId: string, externalUserRef: string) =>
      defaultResolveUserToken(deps.db, companyId, externalUserRef));

  return async function ingestInboundFiles(args: {
    companyId: string;
    issueId: string;
    refId: string;
    authorExternalRef: string;
    files: IncomingFileRef[];
  }): Promise<void> {
    const token = await resolveUserToken(args.companyId, args.authorExternalRef);
    if (!token) {
      // eslint-disable-next-line no-console
      console.warn(
        `slack file-ingest: no user token for ${args.authorExternalRef} in company ${args.companyId}`,
      );
      return;
    }

    for (const file of args.files) {
      try {
        const downloaded = await fetchFile(file.urlPrivate, token);
        if (!downloaded) {
          // eslint-disable-next-line no-console
          console.warn(
            `slack file-ingest: download failed for file ${file.id} (${file.urlPrivate})`,
          );
          continue;
        }
        const contentType = file.mimetype || downloaded.contentType;
        const stored = await deps.storage.putFile({
          companyId: args.companyId,
          namespace: `issues/${args.issueId}`,
          originalFilename: file.name,
          contentType,
          body: downloaded.body,
        });

        await deps.db.transaction(async (tx) => {
          const [asset] = await tx
            .insert(assets)
            .values({
              companyId: args.companyId,
              provider: stored.provider,
              objectKey: stored.objectKey,
              contentType: stored.contentType,
              byteSize: stored.byteSize,
              sha256: stored.sha256,
              originalFilename: stored.originalFilename,
            })
            .returning();

          await tx.insert(issueAttachments).values({
            companyId: args.companyId,
            issueId: args.issueId,
            assetId: asset!.id,
            messagingMessageRefId: args.refId,
          });
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `slack file-ingest: unexpected failure for file ${file.id}`,
          err,
        );
      }
    }
  };
}
