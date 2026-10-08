#!/bin/sh
# Downloads the Speedrun starter kit into ./speedrun-kit and signs the command line in.
#
#   curl -fsSL https://speedrun.scopehealth.com/kit.sh | SPEEDRUN_TOKEN=<your token> sh
#
# The Set up window on the site shows the full command with your token. The judge has to be
# open; before that the command says so and does nothing else. Needs curl, tar and Docker.
set -eu

API="${SPEEDRUN_API:-https://api.speedrun.scopehealth.com}"
DIR="${SPEEDRUN_DIR:-speedrun-kit}"

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed."; }
# The "error" value of a JSON answer, or the whole answer when it is not JSON.
message() { m=$(sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1"); [ -n "$m" ] && printf '%s' "$m" || cat "$1"; }

[ -n "${SPEEDRUN_TOKEN:-}" ] || die "SPEEDRUN_TOKEN is not set. Copy the whole command from the Set up window at https://speedrun.scopehealth.com/#setup."
need curl; need tar
[ ! -e "$DIR" ] || die "$DIR already exists here. Move it away, or run this from another directory."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 1. The site turns the install token into a short-lived token for the judge.
code=$(curl -sS -o "$tmp/session" -w '%{http_code}' -X POST -H "Authorization: Bearer $SPEEDRUN_TOKEN" -H 'Accept: text/plain' "$API/api/cli/session") || die "could not reach $API."
[ "$code" = 200 ] || die "$(cat "$tmp/session")"
judge=$(sed -n 's/^judge_url=//p' "$tmp/session" | tr -d '\r')
landing=$(sed -n 's/^token=//p' "$tmp/session" | tr -d '\r')
[ -n "$judge" ] && [ -n "$landing" ] || die "the site gave an answer this script does not understand."
judge=${judge%/}

# 2. The judge exchanges it for a token of its own, which the command line keeps.
code=$(curl -sS -o "$tmp/exchange" -w '%{http_code}' -X POST -H "Authorization: Bearer $landing" "$judge/api/tokens/exchange") || die "could not reach the judge at $judge."
[ "$code" = 200 ] || die "the judge did not sign you in: $(message "$tmp/exchange")"
token=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/exchange")
[ -n "$token" ] || die "the judge gave an answer this script does not understand."

# 3. The kit itself, checked against the digest the judge sends with it.
say "downloading the kit from $judge"
code=$(curl -sS -o "$tmp/kit.tar.gz" -D "$tmp/headers" -w '%{http_code}' -H "Authorization: Bearer $token" "$judge/api/kit") || die "the download from $judge failed."
[ "$code" = 200 ] || die "$(message "$tmp/kit.tar.gz")"
want=$(tr -d '\r' < "$tmp/headers" | sed -n 's/^[Xx]-[Kk]it-[Ss]ha256:[[:space:]]*//p' | tail -n 1)
if [ -n "$want" ]; then
  if command -v sha256sum >/dev/null 2>&1; then have=$(sha256sum "$tmp/kit.tar.gz" | cut -d' ' -f1); else have=$(shasum -a 256 "$tmp/kit.tar.gz" | cut -d' ' -f1); fi
  [ "$want" = "$have" ] || die "the download is damaged (its digest does not match). Run the command again."
fi
mkdir "$tmp/out"
tar -xzf "$tmp/kit.tar.gz" -C "$tmp/out"
[ -d "$tmp/out/speedrun-kit" ] || die "the kit archive does not have the expected layout."
mv "$tmp/out/speedrun-kit" "$DIR"
say "the kit is in $DIR"

# 4. Load the command line's image and sign in, when Docker is running.
if docker info >/dev/null 2>&1; then
  (cd "$DIR" && ./load-images.sh && ./arena login --server "$judge" --token "$token") || {
    say ""
    say "The sign-in did not finish. Run it again with:"
    say "  cd $DIR && ./arena login --server $judge --token $token"
    exit 1
  }
  say ""
  say "Done. Next:"
  say "  cd $DIR && export PATH=\"\$PWD:\$PATH\""
  say "  arena sets"
else
  say ""
  say "Docker is not running. Start it, then finish with:"
  say "  cd $DIR && ./load-images.sh"
  say "  ./arena login --server $judge --token $token"
fi
