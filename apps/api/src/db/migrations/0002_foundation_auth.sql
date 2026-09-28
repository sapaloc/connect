-- Identity and access (plan §9.1) + auth technical tables (§8.4) + audit (§21.1).

CREATE TABLE party (
  party_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_kind text NOT NULL CHECK (party_kind IN ('ORGANIZATION', 'PERSON')),
  record_status text NOT NULL DEFAULT 'ACTIVE' CHECK (record_status IN ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE TABLE organization (
  party_id uuid PRIMARY KEY REFERENCES party (party_id),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  organization_reference text
);

CREATE TABLE person (
  party_id uuid PRIMARY KEY REFERENCES party (party_id),
  full_name text NOT NULL,
  email citext,
  phone text
);

CREATE TABLE tenant (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operating_organization_id uuid NOT NULL REFERENCES organization (party_id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'ENDED')),
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  currency text NOT NULL DEFAULT 'VND',
  internal_languages text[] NOT NULL DEFAULT '{en,vi}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_account (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_or_login citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  account_status text NOT NULL DEFAULT 'INVITED'
    CHECK (account_status IN ('INVITED', 'ACTIVE', 'BLOCKED', 'ENDED')),
  preferred_language text NOT NULL DEFAULT 'vi' CHECK (preferred_language IN ('en', 'vi')),
  person_party_id uuid REFERENCES person (party_id),
  password_hash text,
  password_changed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (account_status <> 'ACTIVE' OR password_hash IS NOT NULL)
);

-- partner_relationship_id / affiliated_referrer_id get foreign keys in the partner migration.
CREATE TABLE role_assignment (
  role_assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_account (user_id),
  role text NOT NULL
    CHECK (role IN ('PLATFORM_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'STAFF', 'PARTNER_ADMIN', 'REFERRER')),
  scope_type text NOT NULL
    CHECK (scope_type IN ('PLATFORM', 'TENANT', 'PARTNER_RELATIONSHIP', 'AFFILIATED_REFERRER')),
  tenant_id uuid REFERENCES tenant (tenant_id),
  partner_relationship_id uuid,
  affiliated_referrer_id uuid,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES user_account (user_id),
  CONSTRAINT role_assignment_scope CHECK (
    (role = 'PLATFORM_ADMIN' AND scope_type = 'PLATFORM' AND tenant_id IS NULL)
    OR (role IN ('TENANT_ADMIN', 'MANAGER', 'STAFF') AND scope_type = 'TENANT' AND tenant_id IS NOT NULL)
    OR (role = 'PARTNER_ADMIN' AND scope_type = 'PARTNER_RELATIONSHIP'
        AND tenant_id IS NOT NULL AND partner_relationship_id IS NOT NULL)
    OR (role = 'REFERRER' AND tenant_id IS NOT NULL AND (
        (scope_type = 'PARTNER_RELATIONSHIP' AND partner_relationship_id IS NOT NULL)
        OR (scope_type = 'AFFILIATED_REFERRER' AND affiliated_referrer_id IS NOT NULL)))
  )
);

CREATE UNIQUE INDEX role_assignment_active_uq ON role_assignment (
  user_id,
  role,
  COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'),
  COALESCE(partner_relationship_id, '00000000-0000-0000-0000-000000000000'),
  COALESCE(affiliated_referrer_id, '00000000-0000-0000-0000-000000000000')
) WHERE status = 'ACTIVE';

CREATE INDEX role_assignment_tenant_idx ON role_assignment (tenant_id) WHERE status = 'ACTIVE';

CREATE TABLE session (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES user_account (user_id),
  role_assignment_id uuid REFERENCES role_assignment (role_assignment_id),
  support_session boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text
);

CREATE INDEX session_user_active_idx ON session (user_id) WHERE revoked_at IS NULL;

CREATE TABLE invitation (
  invitation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_account (user_id),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES user_account (user_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invitation_user_open_idx ON invitation (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE password_reset (
  password_reset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_account (user_id),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES user_account (user_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_user_open_idx ON password_reset (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE rate_limit_bucket (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE audit_event (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenant (tenant_id),
  actor_user_id uuid REFERENCES user_account (user_id),
  actor_role_assignment_id uuid REFERENCES role_assignment (role_assignment_id),
  event_type text NOT NULL,
  entity_type text,
  entity_id text,
  before_json jsonb,
  after_json jsonb,
  reason text,
  correlation_id text,
  support_session boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_event_tenant_created_idx ON audit_event (tenant_id, created_at DESC);
CREATE INDEX audit_event_entity_idx ON audit_event (entity_type, entity_id);

CREATE FUNCTION audit_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only';
END;
$$;

CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();

-- Supabase exposes the public schema through its Data API. RLS without policies blocks
-- anon/authenticated keys; the API connects as the table owner and is not affected.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE party ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE person ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_bucket ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
