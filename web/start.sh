#!/bin/sh
set -e
port="${PORT:-8080}"
conf=/etc/nginx/conf.d/default.conf
if [ -w "$conf" ]; then
  sed -i "s/listen 8080;/listen ${port};/" "$conf"
fi
exec nginx -g "daemon off;"
