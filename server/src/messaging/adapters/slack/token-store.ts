import { secretService } from "../../../services/secrets.js";
import type { Db } from "../../router.js";

/**
 * Thin token accessor over the existing company-secrets machinery.
 * Write paths (bot install, per-agent OAuth callback) are filled in in Part 10;
 * Phase 1 reads are sufficient for the adapter's runtime needs.
 */
export interface MessagingTokenStore {
  fetchSecretValue(companyId: string, secretId: string): Promise<string>;
}

export function createMessagingTokenStore(db: Db): MessagingTokenStore {
  const secrets = secretService(db);
  return {
    async fetchSecretValue(companyId, secretId) {
      return secrets.resolveSecretValue(companyId, secretId, "latest");
    },
  };
}
