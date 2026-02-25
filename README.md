# Azure Linux Academy ARM Template UI

Web-based ARM template builder for Linux lab environments on Azure.

## Recent Feature Additions

- Optional VM size filtering UI (add/clear filters + active chips).
- Filter-aware VM size picker with explicit no-match messaging.
- VM size attachment limits enforced in UI (`maxNics`, `maxDataDisks`).
- Output gating when validation fails (name, disk, or attachment-limit errors).
- New **Copy + Open Portal** action with inline 5-second warning countdown.
- Deploy warning now includes pop-up allowance guidance when browsers block portal opening.

## Objective

This project provides a single-page HTML tool to build ARM templates for **multi-VM Linux labs** while enforcing compatibility rules between:

- VM size
- VM generation (Gen1/Gen2)
- CPU architecture (x64/Arm64)
- Disk controller (SCSI/NVMe)
- Disk SKU support (Standard/Premium/PremiumV2/Ultra)
- OS image references
- VM attachment limits (NIC and data disk counts)

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
- `tags.maxNics`: maximum supported NIC attachments for the VM size
- `tags.maxDataDisks`: maximum supported data disk attachments for the VM size

### What this controls in the UI

- Which generations are selectable
- Which disk controllers are selectable
- Which OS images are shown
- Which disk SKUs are allowed for data disks
- Whether NIC accelerated networking is forced, optional, or disabled
- Whether Add NIC/Add disk actions are allowed
- Whether generated output can be copied/downloaded/deployed

---

## VM Size Filtering UX

- The VM size section includes an optional filter panel.
- Filters can be added per capability (architecture, generation, controller, disk SKU support, accelerated networking, minimum max NICs, minimum max data disks).
- Active filters are shown as removable chips.
- If no sizes match, the UI shows: **"No VM size matches the filters."**

---

## Validation and Output Gating

The UI blocks output actions when any of these fail:

- VM naming rules (format/uniqueness)
- NIC naming rules (format/uniqueness in VM)
- Data disk size/SKU validation
- VM-size attachment limits (`maxNics`, `maxDataDisks`)

When limits are hit:

- Add NIC/Add disk buttons are disabled
- limit-specific messages are shown
- copy/download/deploy actions are disabled until fixed

---

## Deployment Assist (Copy + Open Portal)

- Output actions include **Copy**, **Copy + Open Portal**, and **Download**.
- **Copy + Open Portal** does the following:
	1. Copies ARM JSON to clipboard
	2. Shows an inline warning/countdown near action buttons
	3. Waits 5 seconds
	4. Opens Azure custom template page: `https://portal.azure.com/#create/Microsoft.Template`
- Warning text reminds users to allow pop-up windows if the portal does not open.

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
	- filter chips and no-match state behave correctly
	- size hints hide/show correctly when filters exclude the current size
	- publisher filter updates image list correctly
	- duplicate VM names are blocked
	- NIC/data disk limits enforce correctly for each size
	- disk SKU coercion works after size changes
	- Copy + Open Portal shows warning/countdown and opens Azure portal (or shows clear pop-up guidance)
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
