#!/bin/bash
# Runs once when the Docker volume is created. Mirrors packages/db/src/scripts/bootstrap.ts.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
  DO \$\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keel_admin') THEN
      CREATE ROLE keel_admin LOGIN PASSWORD 'keel_admin' BYPASSRLS CREATEDB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keel_app') THEN
      CREATE ROLE keel_app LOGIN PASSWORD 'keel_app' NOBYPASSRLS;
    END IF;
  END \$\$;
  ALTER DATABASE keel OWNER TO keel_admin;
  CREATE DATABASE keel_test OWNER keel_admin;
EOSQL
for db in keel keel_test; do
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
  ALTER SCHEMA public OWNER TO keel_admin;
  GRANT USAGE ON SCHEMA public TO keel_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO keel_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO keel_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE keel_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO keel_app;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EOSQL
done
