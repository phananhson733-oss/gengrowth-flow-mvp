export const DEFAULT_ORACLE_GITHUB_REPO = 'phananhson733-oss/oracle';

export function resolveOracleGithubRepo(env = process.env) {
  return env.GG_ORACLE_GITHUB_REPO || DEFAULT_ORACLE_GITHUB_REPO;
}
