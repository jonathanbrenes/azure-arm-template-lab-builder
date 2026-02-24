# Linux ARM Template UI

Web-based ARM template builder for Linux lab environments on Azure.

## Objective

This project provides a single-page HTML tool to build ARM templates for **multi-VM Linux labs** while enforcing compatibility rules between:

- VM size
- VM generation (Gen1/Gen2)
- CPU architecture (x64/Arm64)
- Disk controller (SCSI/NVMe)
- Disk SKU support (Standard/Premium/PremiumV2/Ultra)
- OS image references

The goal is to reduce deployment errors by preventing invalid combinations in the UI before template deployment.

---

## How It Works

The app is a single file (`index.html`) with three main parts:

1. **Data catalogs**
	- `imageOptions`: OS image metadata and compatibility tags
	- `sizeOptions`: VM SKU capabilities and constraints

2. **UI state model**
	- `vms[]`: in-memory array of VM definitions (size, image, NICs, disks, custom data, etc.)

3. **Generator and render pipeline**
	- User changes fields
	- `sanitizeAllVms()` normalizes and auto-corrects incompatible settings
	- `generateArmTemplate(vms)` produces ARM JSON
	- Output and summary table are refreshed

---

## Runtime Flow (High Level)

1. Load catalogs (`imageOptions`, `sizeOptions`)
2. Validate image catalog uniqueness (`validateImageOptionsConfig`)
3. Initialize first VM
4. Render form/tab UI
5. On each input change:
	- enforce constraints
	- optionally show toast messages for auto-fixes
	- regenerate ARM output

---

## How OS Images Are Built (`imageOptions`)

Each entry has:

- `key`: unique identifier used by the UI
- `arch`: `x64` or `Arm64`
- `gen`: `Gen1` or `Gen2`
- `nvmeCapable` / `scsiCapable`: controller compatibility tags
- `label`: UI display string
- `ref`: ARM image reference
  - `publisher`
  - `offer`
  - `sku`
  - `version`

### Key rules

- Entries are grouped by publisher (`RedHat`, `Canonical`, `SUSE`) and sorted by `key`.
- `key` must be unique.
- `ref` (`publisher:offer:sku:version`) must be unique.
- Filtering is done by **generation + architecture + controller (+ optional publisher)**.

### Typical source of truth

Image entries are intended to be generated/validated using Azure CLI metadata scripts and then pasted into `imageOptions`.

---

## How VM Sizes Are Built (`sizeOptions`)

Each size contains:

- `name`: Azure VM SKU (for example `Standard_D4s_v5`)
- `tags.architectures`: supported CPU architectures
- `tags.generations`: supported VM generations
- `tags.diskControllersByGen`: allowed controllers per generation
- `tags.diskSkuSupport`: disk SKU capability map
- `tags.accelNetMode`: `required`, `optional`, or `unsupported`

### What this controls in the UI

- Which generations are selectable
- Which disk controllers are selectable
- Which OS images are shown
- Which disk SKUs are allowed for data disks
- Whether NIC accelerated networking is forced, optional, or disabled

---

## Custom Data Behavior

- Custom data text is base64-encoded directly for ARM `osProfile.customData`.
- Optional checkbox: **Reboot required after deployment**
  - when enabled, appends `sleep 60 && reboot &` to custom data payload.

---

## Ultra Disk Behavior

- If any VM includes a data disk with `UltraSSD_LRS`:
  - `additionalCapabilities.ultraSSDEnabled` is set on that VM
  - a zonal placement parameter is used and VM/PIP are aligned to the selected zone.

---

## Maintenance Guide

When changing this project:

1. Update catalogs first (`imageOptions`, `sizeOptions`).
2. Keep keys stable unless migration is intentional.
3. Ensure no duplicate image `key` or `ref` values.
4. Verify these scenarios manually:
	- size change causes image/controller auto-correction
	- publisher filter updates image list correctly
	- duplicate VM names are blocked
	- disk SKU coercion works after size changes
	- generated ARM validates in portal/CLI

---

## Recommended Enhancements (Future)

- Add unit tests for catalog validation and filtering rules.
- Add export/import of VM configurations.
- Add CI check to detect duplicate image keys/refs before merge.
- Add optional pipeline publishing (GitHub Pages / Azure Static Website).

---

## Project Structure

Current design is intentionally single-file for portability:

- `index.html` — UI, data catalogs, state management, and ARM generation logic

If this grows significantly, consider splitting into:

- `data.images.js`
- `data.sizes.js`
- `generator.js`
- `ui.js`

while preserving the same behavior.
