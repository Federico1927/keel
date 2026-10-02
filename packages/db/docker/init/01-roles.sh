#!/bin/bash
# Runs once when the Docker volume is created. Mirrors packages/db/src/scripts/bootstrap.ts.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
  DO \$\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hullwise_admin') THEN
      CREATE ROLE hullwise_admin LOGIN PASSWORD 'hullwise_admin' BYPASSRLS CREATEDB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hullwise_app') THEN
      CREATE ROLE hullwise_app LOGIN PASSWORD 'hullwise_app' NOBYPASSRLS;
    END IF;
  END \$\$;
  ALTER DATABASE hullwise OWNER TO hullwise_admin;
  CREATE DATABASE hullwise_test OWNER hullwise_admin;
EOSQL
for db in hullwise hullwise_test; do
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
  ALTER SCHEMA public OWNER TO hullwise_admin;
  GRANT USAGE ON SCHEMA public TO hullwise_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE hullwise_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hullwise_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE hullwise_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hullwise_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE hullwise_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO hullwise_app;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EOSQL
done
