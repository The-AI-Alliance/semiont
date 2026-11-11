#!/usr/bin/env bash
set -euo pipefail

apt_options=(
  -o Acquire::Retries=1
  -o Acquire::http::Timeout=10
  -o Acquire::https::Timeout=10
)

for attempt in 1 2; do
  echo "Installing Tesseract (attempt ${attempt}/2)"
  if sudo timeout 90 apt-get "${apt_options[@]}" update -qq &&
    sudo timeout 150 apt-get "${apt_options[@]}" install -y --no-install-recommends tesseract-ocr; then
    tesseract --version
    exit 0
  fi

  if [[ "${attempt}" -lt 2 ]]; then
    echo "APT mirror request failed; retrying once."
    sleep 2
  fi
done

echo "Unable to install Tesseract after two bounded attempts." >&2
exit 1
