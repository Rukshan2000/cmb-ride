#!/bin/sh
# Build and deploy to https://cmb-ride.kwingsmedia.com (nginx serves web/, docker container cmb-ride-api runs backend/).
set -e
HOST=root@164.68.97.187 DIR=/var/www/cmb-ride
cd "$(dirname "$0")/.."
# db.env (DATABASE_URL) lives only on the server. Refuse to ship a backend that can't reach a database.
ssh $HOST "test -s $DIR/backend/db.env" || { echo "missing $DIR/backend/db.env on the server" >&2; exit 1; }
npm run build
rsync -az --delete dist/ $HOST:$DIR/web/
rsync -az --exclude node_modules --exclude db.env --exclude .env.example backend/ $HOST:$DIR/backend/
# The container mounts backend/ read-only, so dependencies are installed from a throwaway one.
ssh $HOST "docker run --rm -v $DIR/backend:/app -w /app node:22-alpine npm install --omit=dev --no-audit --no-fund"
ssh $HOST "chmod 600 $DIR/backend/.env; chown 1000 $DIR/backend/.env; docker restart cmb-ride-api >/dev/null"
sleep 3
# 401 = backend up and database reachable
test "$(curl -s -o /dev/null -w '%{http_code}' -H 'Cookie: session='$(printf '0%.0s' $(seq 64)) https://cmb-ride.kwingsmedia.com/api/me)" = 401 && echo "deployed: https://cmb-ride.kwingsmedia.com"
