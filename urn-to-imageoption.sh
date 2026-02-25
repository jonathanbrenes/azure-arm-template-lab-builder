#!/usr/bin/bash
set -euo pipefail

################################################################################
# urn-to-imageoption.sh
#
# Purpose
#   Convert an Azure Marketplace image URN into one `imageOptions` entry used by
#   the ARM builder UI.
#
# Input
#   Argument 1 (required): URN in the format:
#     publisher:offer:sku:version
#
#   Argument 2 (optional): Azure region for lookup (default: eastus)
#
# Output
#   Prints one JavaScript object in this shape:
#     {
#       key,
#       arch,
#       gen,
#       nvmeCapable,
#       scsiCapable,
#       label,
#       ref: { publisher, offer, sku, version }
#     },
#
# Notes
#   - If version=latest, the script resolves an explicit latest version first.
#   - Disk controller support is inferred from DiskControllerTypes.
#   - `key` is auto-generated from offer/sku/arch/gen and normalized to snake_case.
#
# Requirements
#   - Azure CLI installed (`az`)
#   - Logged in (`az login`) and authorized to query marketplace images
#
# Example
#   ./urn-to-imageoption.sh "Canonical:ubuntu-24_04-lts:server-arm64:latest" eastus
################################################################################

# ------------------------------
# 1) Parse CLI arguments
# ------------------------------
URN="${1:-}"
REGION="${2:-eastus}"

if [[ -z "$URN" ]]; then
  echo "Usage: $0 <publisher:offer:sku:version> [region]" >&2
  exit 1
fi

IFS=':' read -r PUBLISHER OFFER SKU VERSION <<< "$URN"
if [[ -z "${PUBLISHER:-}" || -z "${OFFER:-}" || -z "${SKU:-}" || -z "${VERSION:-}" ]]; then
  echo "Invalid URN. Expected: publisher:offer:sku:version" >&2
  exit 1
fi

INPUT_VERSION="$VERSION"

# ------------------------------
# 2) Resolve `latest` to explicit version
# ------------------------------
# Azure image metadata lookups are more deterministic with an explicit version.
# When `latest` is passed, query all versions for the exact publisher/offer/sku,
# sort them, and pick the newest one.
if [[ "$VERSION" == "latest" ]]; then
  VERSION="$(az vm image list \
    --location "$REGION" \
    --publisher "$PUBLISHER" \
    --offer "$OFFER" \
    --sku "$SKU" \
    --all \
    --query "[?publisher=='$PUBLISHER' && offer=='$OFFER' && sku=='$SKU'].version | sort(@) | [-1]" \
    -o tsv)"
fi

if [[ -z "${VERSION:-}" ]]; then
  echo "Unable to resolve image version for URN: $URN in region: $REGION" >&2
  exit 1
fi

# ------------------------------
# 3) Read image capabilities
# ------------------------------
# Query returns 3 TSV lines:
#   line 1: architecture          (e.g., x64, Arm64)
#   line 2: hyperVGeneration      (e.g., V1, V2)
#   line 3: DiskControllerTypes   (e.g., "SCSI, NVMe")
#
# Use `mapfile` so each line is captured safely (do not parse with word-splitting).
mapfile -t COLS < <(
  az vm image show \
    --location "$REGION" \
    --publisher "$PUBLISHER" \
    --offer "$OFFER" \
    --sku "$SKU" \
    --version "$VERSION" \
    --query "[architecture,hyperVGeneration,(features[?name=='DiskControllerTypes'].value | [0])]" \
    -o tsv
)

# Defensive defaults in case a field is missing.
ARCH="${COLS[0]:-x64}"
HVGEN="${COLS[1]:-V2}"
DCTL="${COLS[2]:-(not published)}"

# ------------------------------
# 4) Normalize values
# ------------------------------
# Azure Hyper-V generation codes to template labels.
case "$HVGEN" in
  V1) GEN="Gen1" ;;
  V2) GEN="Gen2" ;;
  *)  GEN="$HVGEN" ;;
esac

# Parse controller capabilities from free-text value.
# Rule requested:
#   - If NVMe is not defined, assume SCSI is supported by default.
#   - If SCSI is explicitly listed, SCSI is supported.
#   - If only NVMe is listed, treat it as NVMe-only (SCSI=false).
LOWER_DCTL="$(echo "$DCTL" | tr '[:upper:]' '[:lower:]')"
NVME=false
SCSI=false
[[ "$LOWER_DCTL" == *nvme* ]] && NVME=true
[[ "$LOWER_DCTL" == *scsi* ]] && SCSI=true
if [[ "$NVME" == false || "$LOWER_DCTL" == *scsi* ]]; then
  SCSI=true
fi

# ------------------------------
# 5) Build stable key + label
# ------------------------------
# Converts arbitrary text into lowercase snake_case for `key`.
make_key_part() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g'
}

pretty_offer_name() {
  local raw="$1"
  local words out=""
  words="$(echo "$raw" | sed -E 's/[-_]+/ /g')"

  for w in $words; do
    local lw
    lw="$(echo "$w" | tr '[:upper:]' '[:lower:]')"

    case "$lw" in
      rhel) part="RHEL" ;;
      sles) part="SLES" ;;
      suse) part="SUSE" ;;
      sap)  part="SAP" ;;
      lts)  part="LTS" ;;
      sp[0-9]*) part="SP${lw#sp}" ;;
      x86|x86_64|x64) part="x86_64" ;;
      arm64|aarch64) part="Arm64" ;;
      *)
        if [[ "$lw" =~ ^[0-9]+$ ]]; then
          part="$lw"
        else
          part="${lw^}"
        fi
        ;;
    esac

    if [[ -z "$out" ]]; then
      out="$part"
    else
      out+=" $part"
    fi
  done

  echo "$out"
}

pretty_arch_name() {
  local arch="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
  case "$arch" in
    x64|x86_64) echo "x86_64" ;;
    arm64|aarch64) echo "Arm64" ;;
    *) echo "$1" ;;
  esac
}

build_display_name() {
  local offer_name arch_name lower_offer
  offer_name="$(pretty_offer_name "$OFFER")"
  arch_name="$(pretty_arch_name "$ARCH")"
  lower_offer="$(echo "$offer_name" | tr '[:upper:]' '[:lower:]')"

  if [[ "$arch_name" == "x86_64" && "$lower_offer" == *"x86_64"* ]]; then
    echo "$offer_name"
    return
  fi
  if [[ "$arch_name" == "Arm64" && "$lower_offer" == *"arm64"* ]]; then
    echo "$offer_name"
    return
  fi

  echo "$offer_name $arch_name"
}

KEY="$(make_key_part "${OFFER}_${SKU}_${ARCH}_${GEN}")"

emit_entry() {
  local key="$1"
  local ref_version="$2"
  local label_version="$3"
  local display_name
  display_name="$(build_display_name)"

  local label="${display_name} (${GEN}) (${PUBLISHER}:${OFFER}:${SKU}:${label_version})"

  cat <<EOF
    { key: '$key', arch: '$ARCH', gen: '$GEN', nvmeCapable: $NVME, scsiCapable: $SCSI,
      label: '$label',
      ref: { publisher:'$PUBLISHER', offer:'$OFFER', sku:'$SKU', version:'$ref_version' } },
EOF
}

# ------------------------------
# 6) Emit imageOptions entry
# ------------------------------
emit_pinned_entry_for_version() {
  local version="$1"
  local version_key_part
  version_key_part="$(make_key_part "$version")"
  emit_entry "${KEY}_${version_key_part}" "$version" "$version"
}

if [[ "$INPUT_VERSION" == "latest" ]]; then
  # Option 1: Keep ARM ref pinned to latest.
  echo "// Option A: floating latest reference (ref.version='latest')."
  emit_entry "${KEY}_latest" "latest" "latest"

  # Option 2: Pin ARM ref to the currently resolved latest version.
  echo "// Option B: pinned reference to current latest resolved version (ref.version='${VERSION}')."
  emit_pinned_entry_for_version "$VERSION"
else
  echo "// Single option: explicit version reference (ref.version='${VERSION}')."
  emit_pinned_entry_for_version "$VERSION"
fi
