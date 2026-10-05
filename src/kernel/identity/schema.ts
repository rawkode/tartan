// ForgeDO identity DDL (WP2, migrations 100–199). The `idp.client_auth` CHECK
// lists `none` (public client + PKCE), which is also the default. Row types are
// the contract's (`packages/contract/src/do/forge.ts`).

import type { Migration } from "@tartan/contract/kernel.ts";

export const IDENTITY_MIGRATIONS: readonly Migration[] = [
	{
		n: 100,
		name: "identity tables",
		sql: `
CREATE TABLE setup_codes (code_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('bootstrap','recover')),
  source TEXT NOT NULL CHECK (source IN ('secret','logs')),
  expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE consumed_setup_secrets (hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('bootstrap','recover')),
  consumed_at INTEGER NOT NULL, consumed_by TEXT NOT NULL);
CREATE TABLE invites (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
  node_id TEXT NOT NULL, role INTEGER NOT NULL CHECK (role IN (10,20,30,40)), note TEXT,
  relink_principal TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER, used_by_issuer TEXT, used_by_sub TEXT);
CREATE TABLE keys (kid TEXT PRIMARY KEY,
  alg TEXT NOT NULL CHECK (alg IN ('ES256','EdDSA')),
  use TEXT NOT NULL CHECK (use IN ('client-auth','federation')),
  private_jwk_sealed TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','retiring','retired')),
  created_at INTEGER NOT NULL);
CREATE TABLE idp (id TEXT PRIMARY KEY CHECK (id = 'default'),
  issuer TEXT NOT NULL, client_id TEXT NOT NULL,
  client_auth TEXT NOT NULL DEFAULT 'none'
    CHECK (client_auth IN ('none','private_key_jwt','client_secret_basic','client_secret_post')),
  id_token_alg TEXT NOT NULL DEFAULT 'RS256',
  client_secret_sealed TEXT,
  registration_sealed TEXT,
  scopes TEXT NOT NULL DEFAULT 'openid profile email groups',
  metadata_json TEXT NOT NULL, discovered_at INTEGER NOT NULL,
  username_claim TEXT NOT NULL DEFAULT 'preferred_username',
  allowed_email_domains_json TEXT, jit_provisioning INTEGER NOT NULL DEFAULT 0,
  verify_id_token_signature INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL CHECK (source IN ('wizard','dcr','env')), updated_at INTEGER NOT NULL);
CREATE TABLE idp_group_mappings (claim TEXT NOT NULL CHECK (claim IN ('groups','roles')),
  value TEXT NOT NULL, node_id TEXT NOT NULL, role INTEGER NOT NULL CHECK (role IN (10,20,30,40)),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (claim, value, node_id));
CREATE TABLE principals (id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user','agent','ext','system')),
  handle TEXT NOT NULL UNIQUE, display TEXT NOT NULL, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0,
  owner_user_id TEXT REFERENCES principals(id),
  agent_tool TEXT, agent_model TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, disabled_at INTEGER);
CREATE TABLE identities (issuer TEXT NOT NULL, sub TEXT NOT NULL, principal_id TEXT NOT NULL REFERENCES principals(id),
  last_login_at INTEGER NOT NULL, PRIMARY KEY (issuer, sub));
CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user','setup')),
  idp_sid TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL);
CREATE INDEX sessions_principal ON sessions(principal_id);
CREATE TABLE login_txn (state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login','bootstrap','recover')),
  verifier_sealed TEXT NOT NULL, nonce TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL,
  invite_hash TEXT);
CREATE TABLE tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('pat','agent')), principal_id TEXT NOT NULL REFERENCES principals(id),
  name TEXT NOT NULL, scopes_json TEXT NOT NULL,
  node_id TEXT,
  lane_id TEXT,
  max_role INTEGER NOT NULL CHECK (max_role IN (10,20,30,40,50)),
  expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX tokens_principal ON tokens(principal_id);
CREATE TABLE delegations (id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL, user_id TEXT NOT NULL, node_id TEXT NOT NULL, max_role INTEGER NOT NULL,
  scopes_json TEXT NOT NULL, oauth_client_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER)`,
	},
	{
		// `POST /-/admin/idp/deregister` accepts a `TARTAN_DESTROY_TOKEN` once;
		// this table records the consumed ones.
		n: 101,
		name: "consumed destroy tokens",
		sql:
			"CREATE TABLE consumed_destroy_tokens (hash TEXT PRIMARY KEY, consumed_at INTEGER NOT NULL, outcome TEXT NOT NULL)",
	},
];
