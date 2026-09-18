-- Audit history must survive deletion of the profile it describes: admin
-- profile deletion removes the profile row, and the audit trail of that
-- deletion (and everything before it) has to remain queryable afterwards.
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_profile_id_fkey;

-- Audit events about something other than a profile (e.g. an agent deletion)
-- still need to say what they were about.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS subject_id text;
