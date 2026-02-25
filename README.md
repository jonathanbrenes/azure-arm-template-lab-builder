# Azure Linux Academy ARM Template UI

Web-based ARM template builder for Linux lab environments on Azure.

## Features

- Multi-VM ARM template builder in a single-page UI.
- Compatibility-aware image filtering by generation, architecture, disk controller, and optional publisher.
- VM size constraints for generation, controller support, accelerated networking, and disk SKU support.
- Optional VM size capability filters with add/clear flow and removable active chips.
- Attachment limit enforcement per VM size (`maxNics`, `maxDataDisks`).
- Validation for VM names, NIC names, data disk sizes/SKUs, and attachment limits.
- Auto-correction behavior with toast notifications when selections become incompatible.
- ARM output gating: copy/download/deploy actions are disabled until validation issues are fixed.
- Deployment helper action (**Copy + Open Portal**) with inline 5-second countdown and guidance.
- VM summary table for quick review of generated configuration.
- Custom data support with optional reboot behavior.
- Ultra disk handling with zonal placement and `ultraSSDEnabled` support.
- Helper script (`urn-to-imageoption.sh`) to generate `imageOptions` entries from image URNs.

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

## Use the hosted app

You can use the builder directly in your browser:

https://jonathanbrenes.github.io/azure-arm-template-lab-builder/

Quick flow:

1. Open the URL.
2. Add one or more VMs and configure size/image/network/disks.
3. Review the generated ARM JSON and VM summary.
4. Use **Copy**, **Copy + Open Portal**, or **Download**.

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

- Entries are grouped by publisher and sorted by `key`.
- `key` must be unique.
- `ref` (`publisher:offer:sku:version`) must be unique.
- Filtering is done by **generation + architecture + controller (+ optional publisher)**.

### Using `urn-to-imageoption.sh`

Image entries are intended to be generated/validated using Azure CLI metadata scripts and then pasted into `imageOptions`.

You can generate ready-to-paste `imageOptions` entries with the helper script:

- Script: `urn-to-imageoption.sh`
- Input: `publisher:offer:sku:version`
- Optional second argument: Azure region (default: `eastus`)

Requirements to run the script:

- Bash shell environment (Linux, macOS, or WSL/Git Bash on Windows)
- Azure CLI installed (`az`)
- Authenticated Azure session (`az login`)
- Permissions to query marketplace images in the selected subscription/region

Example:

```bash
./urn-to-imageoption.sh "Debian:debian-12:12-arm64:latest" eastus
```

Example output for Debian 13 Gen2:

```text
urn-to-imageoption.sh Debian:debian-13:13-gen2:latest
// Option A: floating latest reference (ref.version='latest').
		{ key: 'debian_13_13_gen2_x64_gen2_latest', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
			label: 'Debian 13 x86_64 (Gen2) (Debian:debian-13:13-gen2:latest)',
			ref: { publisher:'Debian', offer:'debian-13', sku:'13-gen2', version:'latest' } },
// Option B: pinned reference to current latest resolved version (ref.version='0.20260220.2394').
		{ key: 'debian_13_13_gen2_x64_gen2_0_20260220_2394', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
			label: 'Debian 13 x86_64 (Gen2) (Debian:debian-13:13-gen2:0.20260220.2394)',
			ref: { publisher:'Debian', offer:'debian-13', sku:'13-gen2', version:'0.20260220.2394' } },
```

What it does:

- Resolves `latest` to a concrete version for metadata lookup.
- Reads image capabilities from Azure (`architecture`, `hyperVGeneration`, `DiskControllerTypes`).
- Produces a normalized `key`, `label`, and `ref` block in the same object format used by `imageOptions`.
- Emits output already formatted to match the indentation style used in `index.html`.

When `version=latest`, the script emits:

- **Option A**: floating reference (`ref.version='latest'`)
- **Option B**: pinned reference to the currently resolved latest version

Copy the desired emitted object and paste it into the appropriate publisher section in `imageOptions`.

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

## Project Structure

Current design is intentionally simple and portable:

- `index.html` — UI, data catalogs, state management, and ARM generation logic
- `urn-to-imageoption.sh` — helper script to generate and validate `imageOptions` entries from Azure image URNs
