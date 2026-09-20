-- 002_partitions.sql — partition management for the two append-heavy tables.
--
-- Partitions are created ahead of time by ensure_month_partitions(), which the
-- maintenance job calls daily. Creating them lazily on insert would put DDL on
-- the write path, and a missing partition is an outage: Postgres rejects the
-- row rather than routing it anywhere.

CREATE OR REPLACE FUNCTION ensure_month_partitions(months_ahead integer DEFAULT 3)
RETURNS void AS $fn$
DECLARE
  target     date;
  part_name  text;
  range_from timestamptz;
  range_to   timestamptz;
  parent     text;
BEGIN
  FOREACH parent IN ARRAY ARRAY['consultations', 'audit_logs'] LOOP
    -- One month back covers clock skew and late-arriving rows around a
    -- month boundary; months_ahead gives head-room if the job stalls.
    FOR i IN -1 .. months_ahead LOOP
      target     := date_trunc('month', CURRENT_DATE)::date + (i || ' months')::interval;
      range_from := target::timestamptz;
      range_to   := (target + interval '1 month')::timestamptz;
      part_name  := format('%s_p%s', parent, to_char(target, 'YYYYMM'));

      IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
          part_name, parent, range_from, range_to
        );
      END IF;
    END LOOP;
  END LOOP;
END;
$fn$ LANGUAGE plpgsql;

-- Retention: detach rather than delete. A detached partition can be archived to
-- object storage and dropped, which is O(1) instead of a multi-million-row
-- DELETE plus the vacuum debt that follows it.
CREATE OR REPLACE FUNCTION detach_partitions_older_than(parent text, cutoff date)
RETURNS TABLE(detached text) AS $fn$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c   ON c.oid = i.inhrelid
      JOIN pg_class p   ON p.oid = i.inhparent
     WHERE p.relname = parent
       AND c.relname < format('%s_p%s', parent, to_char(cutoff, 'YYYYMM'))
  LOOP
    EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', parent, rec.relname);
    detached := rec.relname;
    RETURN NEXT;
  END LOOP;
END;
$fn$ LANGUAGE plpgsql;

SELECT ensure_month_partitions(3);
