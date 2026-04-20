import type { Db } from "../../router.js";

/** Stub — real implementation lands in Plan B Task 11. */
export async function getLinearWorkspaceTokenForCompany(
  _db: Db,
  _companyId: string,
): Promise<string> {
  throw new Error("Linear workspace token resolver not implemented (Task 11)");
}

/** Stub — real implementation lands in Plan B Task 12. */
export async function getLinearUserTokenBySecretId(
  _db: Db,
  _companyId: string,
  _secretId: string,
): Promise<string> {
  throw new Error("Linear user token resolver not implemented (Task 12)");
}
