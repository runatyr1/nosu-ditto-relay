#!/usr/bin/env bash
# Build THIS repo's Docker image and publish it to ncontainer.io, signing
# through a NIP-46 bunker so no raw key is ever on the runner.
#
#   scripts/publish-container.sh            build + upload + sign
#   scripts/publish-container.sh --dry-run  build + tag-map only; no network writes
#
# ncontainer has no `docker push` and no account: an OCI image is already a
# content-addressed blob graph, so "publishing" is three steps —
#   1. build the image to an OCI layout (a directory of blobs named by sha256),
#   2. upload those blobs to Blossom (BUD-02, a signed kind-24242 auth), and
#   3. sign one kind-30624 event mapping `latest` -> the manifest digest.
# The image NAME is the signing key's npub, so each project publishes its own
# image under whatever identity signs here — which is the whole point: this file
# is a drop-in every component repo carries, and the identity is a CI secret, not
# baked into the repo.
#
# THE BUILD USES A DOCKER DAEMON. `docker buildx ... --output type=oci` needs a
# BuildKit `docker-container` builder, which needs a daemon socket. On ngit-ci
# the coordinator mounts the host daemon into each job container
# (NGIT_CI_ACT_CONTAINER_DAEMON_SOCKET), so the build — including every
# network-dependent RUN step (npm/bun install) — runs on the real host daemon.
# A daemonless buildah build was tried first and does not work on the
# coordinator's unprivileged Proxmox LXC: the nested user namespace forbids the
# netns operations RUN steps need (socket EPERM / slirp cannot join the netns),
# while a real daemon has none of those constraints.
#
# CONFIG, all from the environment (CI injects it from ${{ secrets.* }}):
#
#   NCONTAINER_SIGNER      an nsec / ncryptsec / hex key, OR a bunker:// URL
#   NCONTAINER_CONNECT_AS  (bunker only) the client key nak connects to the
#                          bunker as — the persistent NIP-46 session key
#   NCONTAINER_NPUB        the namespace npub — OUTPUT + guard: when the signer
#                          is a raw key it MUST match, or the published names
#                          would not be what this prints
#   PUBLISH_RELAYS         comma-separated relays the kind-30624 event goes to
#   BLOSSOM_SERVERS        comma-separated Blossom servers the LAYERS upload to.
#                          No default: a container layer is a large octet-stream
#                          blob and media-oriented servers answer 415
#   IMAGE_NAME             the repository name (the 30624 `d` tag). Defaults to
#                          this checkout's directory basename, so a drop-in needs
#                          no per-repo edit; override where they differ
#   CONTAINERFILE          Dockerfile path (default ./Dockerfile)
#   BUILD_CONTEXT          build context (default the repo root)
#
# Needs: docker + buildx (in the runner image), nak (github.com/fiatjaf/nak),
# node. The workflow installs nak; docker/buildx/node ship in the runner image.
#
# OUTWARD-FACING. Without --dry-run it uploads blobs to public Blossom servers
# and publishes a signed event to public relays under the signing identity.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCI_TAGS="$REPO_DIR/scripts/oci-tags.mjs"

IMAGE_NAME="${IMAGE_NAME:-$(basename "$REPO_DIR")}"
CONTAINERFILE="${CONTAINERFILE:-$REPO_DIR/Dockerfile}"
BUILD_CONTEXT="${BUILD_CONTEXT:-$REPO_DIR}"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

die() { printf '\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }
say() { printf '\033[36m==>\033[0m %s\n' "$*"; }

# nak signer flags, shared by the identity guard, the blossom upload (24242) and
# the event (30624). --connect-as is only meaningful for a bunker signer. Emitted
# NUL-delimited so a URL with shell metacharacters survives into an array intact.
# Defined up here because the identity guard below calls it.
nak_signer() {
  printf '%s\0' --sec "$NCONTAINER_SIGNER"
  [ -n "${NCONTAINER_CONNECT_AS:-}" ] && printf '%s\0' --connect-as "$NCONTAINER_CONNECT_AS"
}

# nak talks to a NIP-46 bunker and to relays/Blossom, none of which has an
# internal deadline: a stalled peer makes nak wait FOREVER. That matters here
# because act does not enforce a job's timeout-minutes, so an unbounded nak sits
# until the coordinator's hour-long ceiling — which replaces every finished
# job's result with one synthetic "timed out" entry, losing their logs. Bound
# every nak call so a stuck bunker or relay fails in minutes, named. Overridable
# for a slow link.
NAK_SIGN_TIMEOUT="${NAK_SIGN_TIMEOUT:-90}"       # bunker round-trips (verify + event)
NAK_UPLOAD_TIMEOUT="${NAK_UPLOAD_TIMEOUT:-600}"  # blossom layer uploads, per server

# Run a command under a wall-clock deadline; a timeout (124, or 137 after the
# follow-up KILL) becomes a named failure rather than a bare non-zero exit.
bounded() {
  local secs="$1" what="$2"; shift 2
  local rc=0
  timeout --signal=TERM --kill-after=15 "$secs" "$@" || rc=$?
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    die "$what did not finish within ${secs}s and was killed — the bunker or a relay is not responding (check NCONTAINER_SIGNER / PUBLISH_RELAYS / BLOSSOM_SERVERS)."
  fi
  return "$rc"
}

# ── Preconditions ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
docker buildx version >/dev/null 2>&1 || die "docker buildx not available"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable (is NGIT_CI_ACT_CONTAINER_DAEMON_SOCKET set?)"
command -v node    >/dev/null 2>&1 || die "node not found on PATH (for scripts/oci-tags.mjs)"
[ -f "$OCI_TAGS" ]      || die "missing $OCI_TAGS"
[ -f "$CONTAINERFILE" ] || die "no Dockerfile at $CONTAINERFILE"

: "${NCONTAINER_SIGNER:?set NCONTAINER_SIGNER (an nsec or a bunker:// URL)}"
: "${NCONTAINER_NPUB:?set NCONTAINER_NPUB (the namespace npub)}"

if [ "$DRY_RUN" -ne 1 ]; then
  command -v nak >/dev/null 2>&1 || die "nak not found on PATH (github.com/fiatjaf/nak)"
  : "${PUBLISH_RELAYS:?set PUBLISH_RELAYS}"
  [ -n "${BLOSSOM_SERVERS:-}" ] || die \
"BLOSSOM_SERVERS is empty. A container layer is a large octet-stream blob and
       media-oriented Blossom servers reject it (415). Set it to one or more
       servers that accept large octet-stream uploads, or pass --dry-run."

  # Prove the signer actually signs as NCONTAINER_NPUB BEFORE spending a build —
  # otherwise the event publishes under one pubkey while consumers name another,
  # and the image name (which IS the pubkey) is silently someone else's. A raw
  # key is introspected offline; a bunker is verified by signing one ephemeral,
  # un-broadcast event through it and reading the pubkey back, so a misprovisioned
  # bunker fails here rather than after publishing under the wrong name.
  want_hex="$(nak decode "$NCONTAINER_NPUB" 2>/dev/null | grep -oiE '[0-9a-f]{64}' | head -1 || true)"
  [ -n "$want_hex" ] || die "NCONTAINER_NPUB=$NCONTAINER_NPUB is not a decodable npub"
  signer_hex="$(nak key public "$NCONTAINER_SIGNER" 2>/dev/null || true)"
  if [ -z "$signer_hex" ]; then
    say "verifying bunker identity (one ephemeral signature, not published)"
    mapfile -d '' -t signer < <(nak_signer)
    # Bounded: a bunker that never answers would otherwise hang here forever
    # (act does not enforce the job timeout). On timeout `bounded` dies with a
    # named message; an empty result also trips the guard below.
    ephemeral_event="$(bounded "$NAK_SIGN_TIMEOUT" "bunker identity check" \
      nak event -k 0 -c '' "${signer[@]}" 2>/dev/null || true)"
    signer_hex="$(printf '%s' "$ephemeral_event" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).pubkey||"")}catch{}})' || true)"
    [ -n "$signer_hex" ] || die "could not reach the bunker to verify its identity (NCONTAINER_SIGNER / NCONTAINER_CONNECT_AS)"
  fi
  [ "$signer_hex" = "$want_hex" ] || die \
    "signer signs as $signer_hex but NCONTAINER_NPUB is $want_hex — they must match."
fi

# ── Build to an OCI layout ───────────────────────────────────────────────────
# The default `docker` driver cannot use the OCI exporter; a `docker-container`
# BuildKit builder can. Created per-run with a unique name (concurrent jobs share
# the host daemon) and torn down on exit so nothing is left behind.
LAYOUT="$(mktemp -d)"
BUILDER="ncpub-${IMAGE_NAME}-$$"
cleanup() { docker buildx rm "$BUILDER" >/dev/null 2>&1 || true; rm -rf "$LAYOUT"; }
trap cleanup EXIT
docker buildx create --name "$BUILDER" --driver docker-container >/dev/null

say "build $IMAGE_NAME (linux/amd64) -> OCI layout"
# --provenance/--sbom off: an attestation manifest turns the export into a
# manifest list with an unknown/unknown entry, which would mint a bogus tag.
# amd64-only, per the decision on architectures.
docker buildx build --builder "$BUILDER" --platform linux/amd64 \
  --provenance=false --sbom=false \
  -f "$CONTAINERFILE" \
  -t "$IMAGE_NAME:latest" \
  --output "type=oci,tar=false,dest=$LAYOUT" \
  "$BUILD_CONTEXT"

# Extract the tag->digest map (and write the synthesized index blob into the
# layout). Stdout is the JSON contract; diagnostics are on stderr.
tags_json="$(node "$OCI_TAGS" "$LAYOUT")"

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry-run: $IMAGE_NAME built to $LAYOUT ($(du -sh "$LAYOUT" | cut -f1))"
  printf '    tags: %s\n' "$tags_json"
  exit 0
fi

# ── Upload every blob to each Blossom server ─────────────────────────────────
# manifests, config, layers, and the synthesized index. nak blossom signs a
# kind-24242 auth with the same signer.
IFS=',' read -ra servers <<< "$BLOSSOM_SERVERS"
for server in "${servers[@]}"; do
  server="$(printf '%s' "$server" | tr -d '[:space:]')"
  [ -n "$server" ] || continue
  say "upload $IMAGE_NAME blobs -> $server"
  mapfile -d '' -t signer < <(nak_signer)
  bounded "$NAK_UPLOAD_TIMEOUT" "blossom upload to $server" \
    nak blossom -s "$server" "${signer[@]}" upload "$LAYOUT"/blobs/sha256/* >/dev/null
done

# ── Sign + publish the kind-30624 repository event ───────────────────────────
declare -a evt_tags
evt_tags=(-d "$IMAGE_NAME" -t "title=$IMAGE_NAME")
while IFS=$'\t' read -r name digest; do
  evt_tags+=(-t "tag=${name};${digest}")
done < <(node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const[n,d]of j.tags)process.stdout.write(n+"\t"+d+"\n")' <<<"$tags_json")
for server in "${servers[@]}"; do
  server="$(printf '%s' "$server" | tr -d '[:space:]')"
  [ -n "$server" ] && evt_tags+=(-t "server=$server")
done

say "sign $IMAGE_NAME repository event -> $PUBLISH_RELAYS"
IFS=',' read -ra relays <<< "$PUBLISH_RELAYS"
mapfile -d '' -t signer < <(nak_signer)
bounded "$NAK_SIGN_TIMEOUT" "publish repository event" \
  nak event -k 30624 "${evt_tags[@]}" -c '' "${signer[@]}" "${relays[@]}" >/dev/null

printf '\033[32m    ncontainer.io/%s/%s:latest\033[0m\n' "$NCONTAINER_NPUB" "$IMAGE_NAME"
say "done"
