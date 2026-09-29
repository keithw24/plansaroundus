/**
 * Runs one parameterized statement and returns its rows. Skills and stores get
 * this through their factory, so tests pass a fake and only apps/ open a pool.
 */
export type Query = <Row extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: readonly unknown[],
) => Promise<Row[]>;
