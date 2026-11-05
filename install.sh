#!/bin/sh
# RevCode installer: downloads the single-file build (about 1 MB) and puts `revcode` on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/ayaan-gupta/RevCode/master/install.sh | sh
#
# Set REVCODE_INSTALL_DIR to install somewhere other than ~/.local/bin.
set -eu

REPO="ayaan-gupta/RevCode"
DIR="${REVCODE_INSTALL_DIR:-$HOME/.local/bin}"
URL="${REVCODE_DOWNLOAD_URL:-https://github.com/$REPO/releases/latest/download/revcode.mjs}"

say() { printf '%s\n' "$*"; }
fail() { printf 'revcode install: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "RevCode needs Node.js 20 or newer. Get it from https://nodejs.org (or: brew install node), then run this again."
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || fail "RevCode needs Node.js 20 or newer; you have $(node --version). Update it from https://nodejs.org, then run this again."
command -v git >/dev/null 2>&1 || fail "RevCode needs git. Install it (macOS: xcode-select --install), then run this again."

mkdir -p "$DIR"
tmp=$(mktemp "${TMPDIR:-/tmp}/revcode.XXXXXX")
trap 'rm -f "$tmp"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$tmp" || fail "couldn't download $URL"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$URL" || fail "couldn't download $URL"
else
  fail "needs curl or wget to download RevCode."
fi
head -c 2 "$tmp" | grep -q '#!' || fail "the download from $URL doesn't look like RevCode. Try again in a minute."

mv "$tmp" "$DIR/revcode"
chmod 755 "$DIR/revcode"
trap - EXIT
say "Installed $("$DIR/revcode" --version) to $DIR/revcode"

case ":$PATH:" in
  *":$DIR:"*) say "Run it in a project: cd your-project && revcode" ;;
  *)
    shell_rc="$HOME/.profile"
    case "${SHELL:-}" in */zsh) shell_rc="$HOME/.zshrc" ;; */bash) shell_rc="$HOME/.bashrc" ;; esac
    say ""
    say "$DIR isn't on your PATH yet. Add it:"
    say "  echo 'export PATH=\"$DIR:\$PATH\"' >> $shell_rc && . $shell_rc"
    say "Then: cd your-project && revcode"
    ;;
esac
