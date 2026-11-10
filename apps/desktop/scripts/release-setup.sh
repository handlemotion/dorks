#!/usr/bin/env bash
# One-time setup for the signed macOS release (.github/workflows/desktop-release.yml). Run it yourself; it prints no secret values and
# keeps key material under ~/.dorks-release (mode 700), never in the repo.
#
#   release-setup.sh csr       make a signing key + certificate request (CSR) to upload to Apple
#   release-setup.sh secrets   after Apple issues the certificate: build the .p12 and set the GitHub secrets and variable
#   release-setup.sh p12       rebuild only the .p12 (with macOS-compatible encryption) and set its two secrets
#   release-setup.sh updater   (re)generate only the updater signing key and set its secret and public-key variable
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

# macOS Keychain cannot import the PKCS#12 that OpenSSL 3 writes by default ("Unable to decode the provided data"), so export it
# with the legacy encryption (checked: `security import` accepts this).
make_p12() {
  openssl pkcs12 -export -legacy -inkey "$DIR/dorks.key" -in "$DIR/dorks.pem" -out "$DIR/dorks.p12" -passout "pass:$1" 2>/dev/null \
    || openssl pkcs12 -export -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 -inkey "$DIR/dorks.key" -in "$DIR/dorks.pem" -out "$DIR/dorks.p12" -passout "pass:$1" 2>/dev/null \
    || openssl pkcs12 -export -inkey "$DIR/dorks.key" -in "$DIR/dorks.pem" -out "$DIR/dorks.p12" -passout "pass:$1"
  chmod 600 "$DIR/dorks.p12"
}

# The updater key: tauri prompts for its password itself (never put a password on a command line: it shows in `ps` and logs).
updater_key() {
  if [ ! -f "$DIR/updater.key" ]; then
    echo "Tauri will now ask for a password for the updater key (empty for none); enter the same one again when this script asks."
    (cd "$(dirname "$0")/.." && pnpm tauri signer generate -w "$DIR/updater.key")
    chmod 600 "$DIR/updater.key"
  fi
  read -r -s -p "Updater key password, as entered above (empty for none): " up_pass; echo
}
updater_publish() {
  gh secret set TAURI_SIGNING_PRIVATE_KEY -R "$REPO" < "$DIR/updater.key"
  if [ -n "$up_pass" ]; then printf %s "$up_pass" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R "$REPO"
  else gh secret delete TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R "$REPO" 2>/dev/null || true; fi
  gh variable set TAURI_UPDATER_PUBKEY -R "$REPO" < "$DIR/updater.key.pub"
}

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
    make_p12 "$p12pass"
    read -r -p "Apple ID email: " apple_id
    read -r -s -p "App-specific password (not echoed): " apple_pw; echo
    read -r -p "Team ID: " team
    updater_key
    base64 < "$DIR/dorks.p12" | tr -d '\n' | gh secret set APPLE_CERTIFICATE -R "$REPO"
    printf %s "$p12pass" | gh secret set APPLE_CERTIFICATE_PASSWORD -R "$REPO"
    printf %s "$identity" | gh secret set APPLE_SIGNING_IDENTITY -R "$REPO"
    printf %s "$apple_id" | gh secret set APPLE_ID -R "$REPO"
    printf %s "$apple_pw" | gh secret set APPLE_PASSWORD -R "$REPO"
    printf %s "$team" | gh secret set APPLE_TEAM_ID -R "$REPO"
    gh secret set TAURI_SIGNING_PRIVATE_KEY -R "$REPO" < "$DIR/updater.key"
    updater_publish
    echo "done: secrets and TAURI_UPDATER_PUBKEY set on $REPO. Back up $DIR somewhere safe (password manager); losing updater.key means installed apps cannot update."
    ;;
  p12)
    command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
    [ -f "$DIR/dorks.pem" ] || { echo "no $DIR/dorks.pem: run the 'secrets' step first" >&2; exit 1; }
    read -r -s -p "Choose a password for the .p12 (not echoed): " p12pass; echo
    make_p12 "$p12pass"
    base64 < "$DIR/dorks.p12" | tr -d '\n' | gh secret set APPLE_CERTIFICATE -R "$REPO"
    printf %s "$p12pass" | gh secret set APPLE_CERTIFICATE_PASSWORD -R "$REPO"
    echo "done: APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD updated on $REPO."
    ;;
  updater)
    command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
    updater_key
    updater_publish
    echo "updater key set on $REPO. Back up $DIR (password manager)."
    ;;
  *) echo "usage: $0 csr|secrets|p12|updater" >&2; exit 2 ;;
esac
