#!/usr/bin/env bash
# `git` with the workflow token for this one command only (REVIEW-2 #13). Checkout runs with
# persist-credentials: false, so the write-scoped token is never stored in .git/config while npm code runs;
# only the push steps call this. Needs GH_TOKEN. The header is the same one actions/checkout would persist.
#   git-auth.sh push origin HEAD:main
set -euo pipefail
auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
echo "::add-mask::$auth"
exec git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" "$@"
