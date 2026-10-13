-- Migration: enforce audit_log append-only at DB level
-- Doc: https://www.postgresql.org/docs/current/plpgsql-trigger.html
--
-- This trigger rejects UPDATE and DELETE on audit_log.
-- All writes must go through lib/db/audit.ts (INSERT only).

CREATE OR REPLACE FUNCTION enforce_audit_log_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END;
$fn$;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION enforce_audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION enforce_audit_log_append_only();
