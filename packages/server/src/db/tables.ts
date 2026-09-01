import { TABLES as LOCAL_TABLES, TABLE_ENV_VARS, type TableKey } from '@tacendum/shared';

/**
 * Physical table names. In AWS the CDK stack passes CloudFormation-generated
 * names to Lambda via the `TABLE_ENV_VARS` environment variables; locally and
 * in tests they are unset and the canonical local names apply.
 */
export function readTableNames(env: NodeJS.ProcessEnv = process.env): Record<TableKey, string> {
  const resolved = {} as Record<TableKey, string>;
  for (const key of Object.keys(TABLE_ENV_VARS) as TableKey[]) {
    const fromEnv = env[TABLE_ENV_VARS[key]];
    // '' is never a valid table name. Unlike DDB_ENDPOINT (where '' is the
    // deliberate "real AWS endpoint" sentinel), a set-but-empty table variable
    // is operator drift — fail at load rather than silently issuing requests
    // against the local fallback name in a real Region.
    if (fromEnv === '') {
      throw new Error(`${TABLE_ENV_VARS[key]} is set but empty`);
    }
    resolved[key] = fromEnv ?? LOCAL_TABLES[key];
  }
  return resolved;
}

/** Resolved once at module load; Lambda sets env before any import runs. */
export const TABLES = readTableNames();
