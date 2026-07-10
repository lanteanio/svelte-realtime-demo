#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
. scripts/compose-health.sh

DEPLOY_TIMEOUT_SECONDS=${DEPLOY_TIMEOUT_SECONDS:-180}
APP_REPLICAS=${APP_REPLICAS:-4}
DEPLOY_BASE_URL=${DEPLOY_BASE_URL:-}

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
	echo "ERROR: deploy requires a clean worktree so the revision tag matches the image contents." >&2
	git status --short >&2
	exit 1
fi

if [ -z "$DEPLOY_BASE_URL" ]; then
	domain=${DOMAIN:-}
	if [ -z "$domain" ] && [ -f .env ]; then
		domain=$(sed -n 's/^DOMAIN=//p' .env | tail -n 1)
		domain=${domain%\"}
		domain=${domain#\"}
		domain=${domain%\'}
		domain=${domain#\'}
	fi
	if [ -z "$domain" ]; then
		echo "ERROR: set DEPLOY_BASE_URL or DOMAIN (directly or in .env)." >&2
		exit 1
	fi
	DEPLOY_BASE_URL="https://$domain"
fi

# Running replicas only. A leftover exited container (an interrupted one-off
# `compose run`, or a stopped old replica) must not be read as a live replica on
# a different image and block the deploy behind the ambiguity guard below.
mapfile -t previous_images < <(
	docker compose ps -q app \
		| xargs -r docker inspect --format '{{.Config.Image}}' \
		| sort -u
)

if [ "${#previous_images[@]}" -gt 1 ]; then
	echo "ERROR: app replicas are running different images; refusing an ambiguous rollback." >&2
	printf '  %s\n' "${previous_images[@]}" >&2
	exit 1
fi

previous_image=${previous_images[0]:-}
new_image=
rolled_out=0

run_deployment_smoke() {
	local smoke_image=${1:-$new_image}
	local smoke_mode=${2:-}
	# The smoke script is pure Node built-ins and probes the live site over the
	# network, so the runtime that executes it is incidental. Prefer host node:
	# a rollback triggered by a broken new image must not be verified with that
	# same image (it would re-fail the launch and report a healthy rollback as
	# CRITICAL). Fall back to the image only where host node is unavailable.
	if command -v node >/dev/null 2>&1; then
		node scripts/deployment-smoke.mjs "$DEPLOY_BASE_URL" ${smoke_mode:+"$smoke_mode"}
	else
		docker run --rm --network host --entrypoint node "$smoke_image" \
			scripts/deployment-smoke.mjs "$DEPLOY_BASE_URL" ${smoke_mode:+"$smoke_mode"}
	fi
}

rollback() {
	local original_status=$?
	trap - EXIT

	if [ "$rolled_out" -eq 1 ] && [ -n "$previous_image" ]; then
		echo "Deployment failed; rolling app replicas back to $previous_image..." >&2
		if APP_IMAGE="$previous_image" APP_REPLICAS="$APP_REPLICAS" \
			docker compose -f docker-compose.yml -f docker-compose.rollback.yml \
				up -d --no-deps --force-recreate --scale "app=$APP_REPLICAS" app \
			&& APP_IMAGE="$previous_image" wait_for_app_running "$DEPLOY_TIMEOUT_SECONDS" "$APP_REPLICAS" \
			&& run_deployment_smoke "$new_image" --skip-readiness; then
			echo "Rollback passed process-count and external smoke checks." >&2
		else
			echo "CRITICAL: rollback did not become healthy; operator intervention required." >&2
		fi
	elif [ "$rolled_out" -eq 1 ]; then
		echo "CRITICAL: first deployment failed and no previous app image exists to restore." >&2
	fi

	exit "$original_status"
}

trap rollback EXIT

echo "Pulling latest changes..."
git pull --ff-only

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
	echo "ERROR: pull or a Git hook left local changes; refusing a mislabeled image." >&2
	git status --short >&2
	exit 1
fi

# Tag the image with the exact pulled source revision so rollback never relies
# on a mutable `latest` tag.
revision=$(git rev-parse HEAD)
new_image="svelte-realtime-demo-app:$revision"

echo "Building immutable app image $new_image..."
APP_IMAGE="$new_image" APP_REPLICAS="$APP_REPLICAS" docker compose build --pull app

echo "Smoke-checking the Linux entrypoint bytes..."
docker run --rm --entrypoint /app/entrypoint.sh "$new_image" true

echo "Applying versioned database migrations..."
APP_IMAGE="$new_image" APP_REPLICAS="$APP_REPLICAS" \
	docker compose run --rm --no-deps app npm run migrate

echo "Starting $APP_REPLICAS app replicas..."
rolled_out=1
APP_IMAGE="$new_image" APP_REPLICAS="$APP_REPLICAS" \
	docker compose up -d --no-deps --force-recreate --scale "app=$APP_REPLICAS" app

echo "Waiting up to ${DEPLOY_TIMEOUT_SECONDS}s for every replica to report healthy..."
APP_IMAGE="$new_image" wait_for_app_health "$DEPLOY_TIMEOUT_SECONDS" "$APP_REPLICAS"

echo "Running external HTTP and WebSocket smoke checks against $DEPLOY_BASE_URL..."
run_deployment_smoke

trap - EXIT
echo "Deployed successfully!"
APP_IMAGE="$new_image" docker compose logs --tail 20 app || true
