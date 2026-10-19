#!/bin/sh
# Run a pip command until it works, or say so loudly.
#
# MEASURED 2026-09-22 building docker/researchlab-u24.Dockerfile: pypi.org's
# index answers this host intermittently. torch came down from
# download.pytorch.org at 12.9 MB/s and Ubuntu's mirrors at 7.7 MB/s in the same
# container, while pypi.org returned an empty index twice in a row -- "Could not
# find a version that satisfies the requirement mujoco==3.11.0 (from versions:
# none)" for a package that plainly has one, and the same for pytest an hour
# earlier. pip's own --retries covers a failed connection, not an index page
# that came back empty, so it gives up immediately on exactly this failure.
#
# A build step that fails on someone else's CDN is not a build failure; a step
# that fails five times is.
set -eu

attempts="${PIP_RETRY_ATTEMPTS:-5}"
delay="${PIP_RETRY_DELAY:-20}"
n=1

while : ; do
    if "$@"; then
        exit 0
    fi
    if [ "$n" -ge "$attempts" ]; then
        echo "pip-retry: gave up after $n attempts: $*" >&2
        exit 1
    fi
    echo "pip-retry: attempt $n failed, retrying in ${delay}s: $*" >&2
    n=$((n + 1))
    sleep "$delay"
done
