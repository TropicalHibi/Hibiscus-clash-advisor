#!/usr/bin/env bash
# Opens an issue, or updates the open one with exactly this title (body replaced + a comment), so each failure
# has one issue (SPEC §8.4, §9b). Shared by data-update.yml and meta.yml. Needs GH_TOKEN; runs on Linux runners.
#   upsert-issue.sh <title> <body-file> <comment-for-an-existing-issue>
# The title goes to jq with --arg, never spliced into the filter, so quotes in it can't select another issue.
set -euo pipefail
title="$1"
body="$2"
again="$3"
num="$(gh issue list --state open --search "\"${title//\"/}\" in:title" --json number,title \
       | jq -r --arg t "$title" 'map(select(.title == $t)) | .[0].number // empty')"
if [ -n "$num" ]; then
  gh issue edit "$num" --body-file "$body"
  gh issue comment "$num" --body "$again"
else
  gh issue create --title "$title" --body-file "$body"
fi
