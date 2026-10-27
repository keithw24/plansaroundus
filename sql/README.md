# Migrations

`NNN_name.sql`, applied in order by `npm run migrate` (`packages/pg/src/migrate.ts`), which records each file in `app.migrations`. Every file must also be safe to run twice (`create … if not exists`, additive changes only).

Reserved numbers, so parallel work doesn't collide: `002` safety (NYPD complaints), `003` events (city events).

Tests apply every file to an in-process Postgres (`test/support/pglite.ts`), which has no TimescaleDB. Guard Timescale calls:

```sql
do $$ begin
  if exists (select 1 from pg_extension where extname = 'timescaledb') then
    perform create_hypertable('nypd_complaints', 'occurred_at', if_not_exists => true);
  end if;
end $$;
```
