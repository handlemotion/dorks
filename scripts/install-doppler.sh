#!/usr/bin/env bash
# Install the Doppler CLI if it is missing (Conductor setup script; safe to re-run).
# Official methods: https://docs.doppler.com/docs/install-cli  (Homebrew on macOS, apt/yum repos on Linux).
# Never fails workspace creation: on an unsupported system it prints what to do and exits 0.
set -uo pipefail

if command -v doppler >/dev/null 2>&1; then
  echo "doppler: $(doppler --version) (already installed)"
  exit 0
fi

sudo_cmd=""
[[ "$(id -u)" != "0" ]] && command -v sudo >/dev/null 2>&1 && sudo_cmd="sudo"
key="https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key"

if command -v brew >/dev/null 2>&1; then
  brew install dopplerhq/cli/doppler
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  pm="$(command -v dnf || command -v yum)"
  $sudo_cmd rpm --import "$key" &&
    curl -sLf --retry 3 --tlsv1.2 --proto "=https" "https://packages.doppler.com/public/cli/config.rpm.txt" | $sudo_cmd tee /etc/yum.repos.d/doppler-cli.repo >/dev/null &&
    $sudo_cmd "$pm" install -y doppler
elif command -v apt-get >/dev/null 2>&1; then
  $sudo_cmd apt-get update -y && $sudo_cmd apt-get install -y apt-transport-https ca-certificates curl gnupg &&
    curl -sLf --retry 3 --tlsv1.2 --proto "=https" "$key" | $sudo_cmd gpg --dearmor --yes -o /usr/share/keyrings/doppler-archive-keyring.gpg &&
    echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" | $sudo_cmd tee /etc/apt/sources.list.d/doppler-cli.list >/dev/null &&
    $sudo_cmd apt-get update -y && $sudo_cmd apt-get install -y doppler
else
  echo "doppler: no supported package manager; install it from https://docs.doppler.com/docs/install-cli" >&2
  exit 0
fi

if command -v doppler >/dev/null 2>&1; then
  echo "doppler: installed $(doppler --version)"
else
  echo "doppler: install failed; see https://docs.doppler.com/docs/install-cli" >&2
fi
exit 0
