/** Returns the same Postgres URL pointed at another database. */
export function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
