#!/usr/bin/env bash
# Puts the AppImage tools in place, checksum-verified, before any signing key is in the environment
# (DESIGN §20.11). Without this, tauri-cli 2.12.4 (tauri-bundler 2.10.4) downloads linuxdeploy, AppRun and
# linuxdeploy-plugin-appimage while bundling, and the plugin's appimagetool downloads the AppImage runtime
# (the ELF header of every AppImage it writes) from a `continuous` tag: all of it unverified, inside the step
# that holds TAURI_SIGNING_PRIVATE_KEY.
#
#   bash packages/desktop/scripts/appimage-tools.sh    (needs curl and sha256sum)
#
# Files go where the bundler looks first (`${XDG_CACHE_HOME:-$HOME/.cache}/tauri`, file names of
# tauri-bundler's linux/appimage/linuxdeploy.rs, which skips a download when the file exists). The runtime
# goes next to them; its path is appended to $GITHUB_ENV as LDAI_RUNTIME_FILE (read by
# linuxdeploy-plugin-appimage, which then passes `--runtime-file` to appimagetool), or printed on stdout as
# an `export` line when not running in GitHub Actions (progress goes to stderr), for a local build:
#
#   eval "$(XDG_CACHE_HOME="$t/cache" bash scripts/appimage-tools.sh)"
#   XDG_CACHE_HOME="$t/cache" cargo tauri build …
#
# A file already present must match its pin, else the script fails rather than replace it. When tauri-cli
# is bumped, compare these names and URLs with the new tauri-bundler's linuxdeploy.rs. When upstream
# replaces the `continuous` plugin asset, this fails until the new file is reviewed and its SHA-256 pinned
# (GitHub shows each release asset's digest: `gh api repos/<owner>/<repo>/releases`).
set -euo pipefail

dir="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"

# name | url | sha256 | sha256 of the bundler's patched copy (it zeroes the AppImage magic bytes 8..10 of
# its cached linuxdeploy on every run), or -
tools=(
  "AppRun-x86_64|https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64|f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f|-"
  "linuxdeploy-07333c6-x86_64.AppImage|https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-07333c6/linuxdeploy-x86_64.AppImage|36a2d7e274d12e1050d0e9ecfe11d339ed54720b2bec464c286d53f8b07f5c62|bd9521cd5ff3ca351fecb78cd9b236a4e37b3621014ac05cac0c2d767ffa0474"
  "linuxdeploy-plugin-appimage.AppImage|https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage|49d6a17160675a6bd1781699aae6bdf7692d98552e02a3671d2183d10547842e|-"
  "appimage-runtime-20251108-x86_64|https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64|2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d|-"
)

sha() { sha256sum "$1" | cut -d' ' -f1; }

mkdir -p "$dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for entry in "${tools[@]}"; do
  IFS='|' read -r name url want patched <<<"$entry"
  target="$dir/$name"
  if [[ -e "$target" || -L "$target" ]]; then
    got="$(sha "$target")"
    if [[ ! -f "$target" || -L "$target" || ( "$got" != "$want" && "$got" != "$patched" ) ]]; then
      echo "appimage-tools: $target does not match its pin (sha256 $got); remove it and run again" >&2
      exit 1
    fi
    echo "appimage-tools: $name ok (already present)" >&2
  else
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$tmp/$name" "$url"
    got="$(sha "$tmp/$name")"
    if [[ "$got" != "$want" ]]; then
      echo "appimage-tools: $url has sha256 $got, expected $want" >&2
      exit 1
    fi
    chmod 0755 "$tmp/$name"
    mv "$tmp/$name" "$target"
    echo "appimage-tools: $name ok (downloaded)" >&2
  fi
done

runtime="$dir/appimage-runtime-20251108-x86_64"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "LDAI_RUNTIME_FILE=$runtime" >>"$GITHUB_ENV"
else
  echo "export LDAI_RUNTIME_FILE=$runtime"
fi
