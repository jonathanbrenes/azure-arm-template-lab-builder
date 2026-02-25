#!/usr/bin/bash
set -euo pipefail

################################################################################
# sku-to-sizeoption.sh
#
# Purpose
#   Convert an Azure VM SKU into one `sizeOptions` entry used by the ARM builder UI.
#
# Input
#   Argument 1 (required): VM SKU name (for example: Standard_D2ps_v5)
#   Argument 2 (optional): Azure region (default: eastus)
#
# Output
#   Prints one JavaScript object in this shape:
#     {
#       name,
#       tags: {
#         architectures,
#         generations,
#         diskControllersByGen,
#         diskSkuSupport,
#         accelNetMode,
#         ephemeralOsDiskSupported,
#         maxNics,
#         maxDataDisks
#       }
#     },
#
# Notes
#   - `accelNetMode` can be inferred as `optional` or `unsupported` from Azure SKU
#     capabilities. If you need `required`, adjust manually after generation.
#   - Generation-specific controller mapping is inferred conservatively:
#       Gen1 -> SCSI only
#       Gen2 -> SCSI + NVMe (if NVMe capability exists), otherwise SCSI
#
# Requirements
#   - Azure CLI installed (`az`)
#   - Logged in (`az login`)
################################################################################

SKU_NAME="${1:-}"
REGION="${2:-eastus}"

if [[ -z "$SKU_NAME" ]]; then
  echo "Usage: $0 <vm-sku-name> [region]" >&2
  exit 1
fi

normalize_bool() {
  local v
  v="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$v" in
    true|1|yes) echo "true" ;;
    *) echo "false" ;;
  esac
}

make_arch_list() {
  local arch
  arch="$(echo "${1:-x64}" | xargs)"
  if [[ "$arch" == "Arm64" ]]; then
    echo "['Arm64']"
  else
    echo "['x64']"
  fi
}

make_generations_list() {
  local hv
  hv="$(echo "${1:-V2}" | tr -d ' ' | tr '[:upper:]' '[:lower:]')"

  local has_v1=false
  local has_v2=false
  [[ "$hv" == *v1* ]] && has_v1=true
  [[ "$hv" == *v2* ]] && has_v2=true

  if [[ "$has_v1" == true && "$has_v2" == true ]]; then
    echo "['Gen1','Gen2']"
  elif [[ "$has_v1" == true ]]; then
    echo "['Gen1']"
  else
    echo "['Gen2']"
  fi
}

has_generation() {
  local gens="$1"
  local needle="$2"
  [[ "$gens" == *"'$needle'"* ]]
}

# Read selected capability values from a single az vm list-skus call.
# Fields (in this exact order):
#   1 CpuArchitectureType
#   2 HyperVGenerations
#   3 DiskControllerTypes
#   4 AcceleratedNetworkingEnabled
#   5 MaxNetworkInterfaces
#   6 MaxDataDiskCount
#   7 PremiumIO
#   8 PremiumV2Supported
#   9 UltraSSDAvailable (top-level capability)
#  10 UltraSSDAvailable (zoneDetails capability fallback)
#  11 EphemeralOSDiskSupported
mapfile -t SKU_CAPS < <(
  az vm list-skus \
    --location "$REGION" \
    --resource-type virtualMachines \
    --all \
    --query "[?name=='$SKU_NAME'] | [0].[capabilities[?name=='CpuArchitectureType'] | [0].value, capabilities[?name=='HyperVGenerations'] | [0].value, capabilities[?name=='DiskControllerTypes'] | [0].value, capabilities[?name=='AcceleratedNetworkingEnabled'] | [0].value, capabilities[?name=='MaxNetworkInterfaces'] | [0].value, capabilities[?name=='MaxDataDiskCount'] | [0].value, capabilities[?name=='PremiumIO'] | [0].value, capabilities[?name=='PremiumV2Supported'] | [0].value, capabilities[?name=='UltraSSDAvailable'] | [0].value, locationInfo[0].zoneDetails[0].capabilities[?name=='UltraSSDAvailable'] | [0].value, capabilities[?name=='EphemeralOSDiskSupported'] | [0].value]" \
    -o tsv
)

ARCH="${SKU_CAPS[0]:-}"
HYPERV="${SKU_CAPS[1]:-}"
DCTL="${SKU_CAPS[2]:-}"
ACCEL="${SKU_CAPS[3]:-}"
MAX_NICS="${SKU_CAPS[4]:-}"
MAX_DISKS="${SKU_CAPS[5]:-}"
PREMIUM_IO="${SKU_CAPS[6]:-}"
PREMIUM_V2="${SKU_CAPS[7]:-}"
ULTRA_SSD="${SKU_CAPS[8]:-}"
ULTRA_SSD_ZONE="${SKU_CAPS[9]:-}"
EPHEMERAL_OS_DISK="${SKU_CAPS[10]:-}"

# Normalize Azure placeholder values.
for v in ARCH HYPERV DCTL ACCEL MAX_NICS MAX_DISKS PREMIUM_IO PREMIUM_V2 ULTRA_SSD ULTRA_SSD_ZONE EPHEMERAL_OS_DISK; do
  if [[ "${!v:-}" == "None" || "${!v:-}" == "null" ]]; then
    printf -v "$v" '%s' ""
  fi
done

if [[ -z "${ARCH:-}" && -z "${HYPERV:-}" && -z "${MAX_NICS:-}" && -z "${MAX_DISKS:-}" ]]; then
  echo "Unable to resolve SKU '$SKU_NAME' in region '$REGION'." >&2
  echo "This usually means the SKU name is wrong or not returned in that region." >&2
  echo "Tip: check exact SKU name with: az vm list-skus --location $REGION --resource-type virtualMachines -o table" >&2
  exit 1
fi

ARCH="${ARCH:-x64}"
HYPERV="${HYPERV:-V2}"
DCTL="${DCTL:-SCSI}"
MAX_NICS="${MAX_NICS:-2}"
MAX_DISKS="${MAX_DISKS:-4}"

PREMIUM_IO_BOOL="$(normalize_bool "${PREMIUM_IO:-false}")"
PREMIUM_V2_BOOL="$(normalize_bool "${PREMIUM_V2:-false}")"
ULTRA_TOP_BOOL="$(normalize_bool "${ULTRA_SSD:-false}")"
ULTRA_ZONE_BOOL="$(normalize_bool "${ULTRA_SSD_ZONE:-false}")"
ACCEL_BOOL="$(normalize_bool "${ACCEL:-false}")"
EPHEMERAL_OS_DISK_BOOL="$(normalize_bool "${EPHEMERAL_OS_DISK:-false}")"

if [[ "$ULTRA_TOP_BOOL" == "true" || "$ULTRA_ZONE_BOOL" == "true" ]]; then
  ULTRA_BOOL="true"
else
  ULTRA_BOOL="false"
fi

if [[ "$ACCEL_BOOL" == "true" ]]; then
  ACCEL_MODE="optional"
else
  ACCEL_MODE="unsupported"
fi

ARCH_LIST="$(make_arch_list "$ARCH")"
GENERATIONS_LIST="$(make_generations_list "$HYPERV")"

LOWER_DCTL="$(echo "$DCTL" | tr '[:upper:]' '[:lower:]')"
HAS_NVME=false
[[ "$LOWER_DCTL" == *nvme* ]] && HAS_NVME=true

# PremiumV2Supported is not always populated in SKU capabilities.
# Fallback heuristic:
# - if explicit flag is present, use it
# - else if Premium IO + NVMe + Gen2 are present, treat as PremiumV2-capable
if [[ -z "${PREMIUM_V2:-}" ]]; then
  HAS_GEN2=false
  [[ "$(echo "$HYPERV" | tr '[:upper:]' '[:lower:]')" == *v2* ]] && HAS_GEN2=true
  if [[ "$PREMIUM_IO_BOOL" == "true" && "$HAS_NVME" == true && "$HAS_GEN2" == true ]]; then
    PREMIUM_V2_BOOL="true"
  fi
fi

GEN1_CONTROLLERS="['SCSI']"
GEN2_CONTROLLERS="['SCSI']"
if [[ "$HAS_NVME" == true ]]; then
  GEN2_CONTROLLERS="['SCSI','NVMe']"
fi

emit_disk_controllers_by_gen() {
  local gens="$1"
  if has_generation "$gens" "Gen1" && has_generation "$gens" "Gen2"; then
    cat <<EOF
      diskControllersByGen: {
        Gen1: ${GEN1_CONTROLLERS},
        Gen2: ${GEN2_CONTROLLERS}
      },
EOF
  elif has_generation "$gens" "Gen1"; then
    cat <<EOF
      diskControllersByGen: {
        Gen1: ${GEN1_CONTROLLERS}
      },
EOF
  else
    cat <<EOF
      diskControllersByGen: {
        Gen2: ${GEN2_CONTROLLERS}
      },
EOF
  fi
}

cat <<EOF
  {
    name: '${SKU_NAME}',
    tags: {
      architectures: ${ARCH_LIST},
      generations: ${GENERATIONS_LIST},
$(emit_disk_controllers_by_gen "$GENERATIONS_LIST")
      diskSkuSupport: {
        Standard_LRS: true,
        StandardSSD_LRS: true,
        Premium_LRS: ${PREMIUM_IO_BOOL},
        PremiumV2_LRS: ${PREMIUM_V2_BOOL},
        UltraSSD_LRS: ${ULTRA_BOOL}
      },
      accelNetMode: '${ACCEL_MODE}',
      ephemeralOsDiskSupported: ${EPHEMERAL_OS_DISK_BOOL},
      maxNics: ${MAX_NICS},
      maxDataDisks: ${MAX_DISKS}
    }
  },
EOF
