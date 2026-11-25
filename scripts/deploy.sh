#!/bin/sh
# Build and deploy to https://cmb-ride.kwingsmedia.com (nginx serves web/, docker container cmb-ride-api runs backend/).
set -e
HOST=root@164.68.97.187 DIR=/var/www/cmb-ride
cd "$(dirname "$0")/.."
npm run build
rsync -az --delete dist/ $HOST:$DIR/web/
rsync -az backend/ $HOST:$DIR/backend/
ssh $HOST "chmod 600 $DIR/backend/.env; chown 1000 $DIR/backend/.env; docker restart cmb-ride-api >/dev/null"
curl -sf -o /dev/null https://cmb-ride.kwingsmedia.com && echo "deployed: https://cmb-ride.kwingsmedia.com"
