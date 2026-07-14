#!/bin/sh
exec "$GIT_ASKPASS_NODE" "$(dirname "$0")/git-askpass.js" "$@"
