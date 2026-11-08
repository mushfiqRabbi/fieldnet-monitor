#!/bin/sh
# Extra databases: one for the automated tests, so `docker compose run test`
# never wipes the data the console is showing.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -c "CREATE DATABASE fieldnet_test OWNER $POSTGRES_USER;"
