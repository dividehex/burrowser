#!/bin/sh
set -eu

# Microsoft Playwright's Chromium-compatible profile. Keep the checksum in
# sync with the reviewed upstream file; a mismatch must stop installation.
url='https://raw.githubusercontent.com/microsoft/playwright/main/utils/docker/seccomp_profile.json'
sha256='cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849'
target='/var/lib/kubelet/seccomp/burrowser/chromium.json'
tmp="${target}.download"
trap 'rm -f "$tmp"' EXIT HUP INT TERM
command -v curl >/dev/null 2>&1 || { echo 'curl is required' >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo 'sha256sum is required' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo 'jq is required' >&2; exit 1; }
mkdir -p "$(dirname "$target")"
curl --fail --show-error --silent --location --retry 3 --output "$tmp" "$url"
printf '%s  %s\n' "$sha256" "$tmp" | sha256sum -c -
jq '(.syscalls[0].names) += (if (.syscalls[0].names | index("clone3")) then [] else ["clone3"] end)' "$tmp" > "${tmp}.extended"
python3 -m json.tool "${tmp}.extended" >/dev/null
install -o root -g root -m 0644 "${tmp}.extended" "$target"
trap - EXIT HUP INT TERM
printf 'Installed reviewed Chromium seccomp profile at %s\n' "$target"
