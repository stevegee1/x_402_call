-- Customer sign-in for the credits (fiat) rail. A customer user owns one credit account; the
-- account keeps its API keys for machine use, and the user signs in to the browser account page.
-- Passwords are stored only as scrypt hashes; browser sessions only as SHA-256 of the cookie.
create table customer_users (
  id             uuid primary key,
  account_id     uuid not null unique references credit_accounts (id),
  email          text not null,
  password_hash  text not null,
  -- Lockout against password guessing, shared by every replica.
  failed_logins  integer not null default 0 check (failed_logins >= 0),
  locked_until   timestamptz,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);
create unique index customer_users_email on customer_users (lower(email));

create table customer_sessions (
  token_hash  text primary key,
  user_id     uuid not null references customer_users (id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create index customer_sessions_user on customer_sessions (user_id);

