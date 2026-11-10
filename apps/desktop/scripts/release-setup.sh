#!/usr/bin/env bash
# One-time setup for the signed macOS release (.github/workflows/desktop-release.yml). Run it yourself; it prints no secret values and
# keeps key material under ~/.dorks-release (mode 700), never in the repo.
#
#   release-setup.sh csr       make a signing key + certificate request (CSR) to upload to Apple
#   release-setup.sh secrets   after Apple issues the certificate: build the .p12 and set the GitHub secrets and variable
#
# Apple steps in between (developer.apple.com, signed in as the account holder):
#   1. Certificates, IDs & Profiles > Certificates > + > "Developer ID Application" > upload ~/.dorks-release/dorks.csr
#      (profile type "G2 Sub-CA"). Download the issued .cer and keep its path.
#   2. appleid.apple.com > Sign-In and Security > App-Specific Passwords > create one named "dorks notarization".
#   3. Your Team ID: developer.apple.com > Membership details.
set -euo pipefail
DIR="$HOME/.dorks-release"
REPO="${REPO:-handlemotion/dorks}"
mkdir -p "$DIR" && chmod 700 "$DIR"

case "${1:-}" in
  csr)
    read -r -p "Email for the certificate request: " email
    read -r -p "Your name (as on the Apple account): " name
    [ -f "$DIR/dorks.key" ] || openssl genrsa -out "$DIR/dorks.key" 2048 2>/dev/null
    chmod 600 "$DIR/dorks.key"
    openssl req -new -key "$DIR/dorks.key" -out "$DIR/dorks.csr" -subj "/emailAddress=$email/CN=$name/C=MX"
    echo "wrote $DIR/dorks.csr: upload it in the Apple portal (step 1 above). The private key stays in $DIR/dorks.key."
    ;;
  secrets)
    command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
    gh auth status >/dev/null || { echo "run 'gh auth login' first (needs permission to write repository secrets)" >&2; exit 1; }
    read -r -p "Path to the downloaded Developer ID Application .cer: " cer
    openssl x509 -inform der -in "$cer" -out "$DIR/dorks.pem"
    identity="$(openssl x509 -in "$DIR/dorks.pem" -noout -subject -nameopt multiline | awk -F= '/commonName/ {sub(/^ +/,"",$2); print $2}')"
    echo "signing identity: $identity"
    read -r -s -p "Choose a password for the .p12 (not echoed): " p12pass; echo
    openssl pkcs12 -export -inkey "$DIR/dorks.key" -in "$DIR/dorks.pem" -out "$DIR/dorks.p12" -passout "pass:$p12pass"
    chmod 600 "$DIR/dorks.p12"
    read -r -p "Apple ID email: " apple_id
    read -r -s -p "App-specific password (not echoed): " apple_pw; echo
    read -r -p "Team ID: " team
    # Updater key (Tauri): generated once, the public half is a repository variable.
    if [ ! -f "$DIR/updater.key" ]; then
      read -r -s -p "Password for the updater signing key (empty for none): " up_pass; echo
      (cd "$(dirname "$0")/.." && pnpm tauri signer generate -w "$DIR/updater.key" ${up_pass:+-p "$up_pass"} >/dev/null)
      chmod 600 "$DIR/updater.key"
    else
      read -r -s -p "Updater key password (empty for none): " up_pass; echo
    fi
    base64 < "$DIR/dorks.p12" | tr -d '\n' | gh secret set APPLE_CERTIFICATE -R "$REPO"
    printf %s "$p12pass" | gh secret set APPLE_CERTIFICATE_PASSWORD -R "$REPO"
    printf %s "$identity" | gh secret set APPLE_SIGNING_IDENTITY -R "$REPO"
    printf %s "$apple_id" | gh secret set APPLE_ID -R "$REPO"
    printf %s "$apple_pw" | gh secret set APPLE_PASSWORD -R "$REPO"
    printf %s "$team" | gh secret set APPLE_TEAM_ID -R "$REPO"
    gh secret set TAURI_SIGNING_PRIVATE_KEY -R "$REPO" < "$DIR/updater.key"
    [ -z "$up_pass" ] || printf %s "$up_pass" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R "$REPO"
    gh variable set TAURI_UPDATER_PUBKEY -R "$REPO" < "$DIR/updater.key.pub"
    echo "done: secrets and TAURI_UPDATER_PUBKEY set on $REPO. Back up $DIR somewhere safe (password manager); losing updater.key means installed apps cannot update."
    ;;
  *) echo "usage: $0 csr|secrets" >&2; exit 2 ;;
esac
