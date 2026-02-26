# Linux ARM Template UI

Web-based ARM template builder for Linux lab environments on Azure.

## Features

- Multi-VM ARM template builder in a single-page UI.
- Compatibility-aware image filtering by generation, architecture, disk controller, and optional publisher.
- VM size constraints for generation, controller support, accelerated networking, and disk SKU support.
- Optional VM size capability filters (9 dimensions) with add/clear flow and removable active chips.
- Header-level **Extra options** overlay flow for environment settings, with click-outside-to-close dismiss.
- Optional SMB/NFS Azure Files resource generation with protocol-specific toggles.
- Share-name validation for SMB/NFS (length + allowed format), with output gating on validation errors.
- Storage configuration summary that appears only when SMB and/or NFS is enabled.
- Attachment limit enforcement per VM size (`maxNics`, `maxDataDisks`).
- Validation for VM names, NIC names, data disk sizes/SKUs, and attachment limits.
- Auto-correction behavior with toast notifications when selections become incompatible.
- ARM output gating: copy/download/deploy actions are disabled until validation issues are fixed.
- Deployment helper action (**Copy + Portal**) with inline countdown and guidance.
- **Import JSON**: load a previously generated ARM template to re-populate the tool.
- VM summary table for quick review of generated configuration.
- Custom data support with optional reboot behavior.
- Ultra disk handling with zonal placement and `ultraSSDEnabled` support.
- **localStorage persistence**: VM configuration, filters, and active tab are saved/restored across page reloads.
- **Accessibility**: ARIA tablist with arrow-key navigation, focus-trapped filter panel, aria-live size count announcements.
- **Button groups**: segmented control layout for export and VM actions.
- Named constants (`LIMITS` object) for all magic numbers.
- Per-cycle computation caches to avoid redundant work during render.
- Targeted render helpers to minimize DOM teardown on common interactions.
- Comprehensive JSDoc documentation on all JavaScript functions for IDE support and maintainability.
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

The app is a single HTML file with embedded CSS and JavaScript. Main parts:

1. **Data catalogs** (validated at startup)
	- `imageOptions`: OS image metadata and compatibility tags
	- `sizeOptions`: VM SKU capabilities and constraints

3. **Centralized state** (`state` object)
	- `vms[]`: in-memory array of VM definitions (size, image, NICs, disks, custom data, etc.)
	- `sizeFilters`: active filter panel selections
	- `storageOptions`: SMB/NFS optional storage settings and share names
	- `extraOptionsOpen`: overlay open/close state for Extra options flow
	- `activeVmIndex`: currently selected VM tab
	- Per-cycle caches (`_imageCache`, `_dupVmNamesCache`) cleared by `invalidateCycleCaches()`
	- `globalThis` property accessors (`vms`, `active`, `sizeFilters`) for backward compatibility
	- `localStorage` persistence via `saveUiState()` / `loadUiState()`

3. **Named constants** (`LIMITS` object, frozen)
	- `VM_NAME_MAX_LEN`, `AZ_NETWORK_NAME_MAX_LEN`, `DEFAULT_DATA_DISK_GB`, `FALLBACK_MAX_DISK_GB`, `TOAST_DURATION_MS`, `COPY_FEEDBACK_MS`, `DEPLOY_COUNTDOWN_S`

4. **Generator and render pipeline**
	- User changes fields
	- `sanitizeAllVms()` normalizes and auto-corrects incompatible settings
	- `generateArmTemplate(vms, storageOptions)` produces ARM JSON
	- Output and summary table are refreshed
	- Full render via `render()` for tab switches, add/remove VM, filter changes
	- Targeted helpers for common interactions:
		- `renderVmFormFields(vm)`: update form values without DOM creation
		- `renderVmSelects(vm)`: repopulate gen/controller/publisher/image dropdowns
		- `updateNicDiskButtons(vm)`: refresh Add NIC/Add Disk disabled state
		- `updateNicNameConstraints(vm)`: patch NIC maxLength + errors in-place

5. **Import** (`importFromArmJson()`)
	- Parses ARM template JSON, matches VM sizes and images to catalogs
	- Imports NICs (name, accel, publicIp), data disks (size, SKU)
	- Skips unrecognized VMs with summary toast
	- Custom data is cleared (encoding can't be reversed)

---

## Runtime Flow (High Level)

1. Load catalogs (`imageOptions`, `sizeOptions`)
2. Validate catalogs at startup (`validateImageOptionsConfig`, `validateSizeOptionsConfig`)
3. Restore saved state from localStorage (VMs, filters, active tab)
4. Initialize default VM if no saved state exists
5. Render form/tab UI (full `render()` pipeline)
6. On each input change:
	- invalidate per-cycle caches
	- enforce constraints via `sanitizeAllVms()`
	- optionally show toast messages for auto-fixes
	- apply optional SMB/NFS storage settings from Extra options
	- regenerate ARM output
	- save state to localStorage

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

### Using `sku-to-sizeoption.sh`

Size entries can be generated from Azure CLI metadata using the helper script.

- Script: `sku-to-sizeoption.sh`
- Input: VM SKU name (for example `Standard_D2ps_v5`)
- Optional second argument: Azure region (default: `eastus`)

Requirements to run the script:

- Bash shell environment (Linux, macOS, or WSL/Git Bash on Windows)
- Azure CLI installed (`az`)
- Authenticated Azure session (`az login`)
- Permissions to query VM SKU capabilities in the selected subscription/region

Example:

```bash
./sku-to-sizeoption.sh Standard_D2ps_v5 eastus
```

Example output:

```text
  {
    name: 'Standard_D2ps_v5',
    tags: {
      architectures: ['Arm64'],
      generations: ['Gen2'],
      diskControllersByGen: {
        Gen2: ['SCSI']
      },
      diskSkuSupport: {
        Standard_LRS: true,
        StandardSSD_LRS: true,
        Premium_LRS: true,
        PremiumV2_LRS: false,
        UltraSSD_LRS: true
      },
      accelNetMode: 'optional',
      ephemeralOsDiskSupported: false,
      maxNics: 2,
      maxDataDisks: 8
    }
  },
```

What it does:

- Queries `az vm list-skus` for the given SKU in the specified region.
- Reads capabilities: architecture, HyperV generations, disk controller types, accelerated networking, Premium/PremiumV2/Ultra disk support, ephemeral OS disk support, max NICs, and max data disks.
- Infers generation-specific disk controller mapping (Gen1 → SCSI only; Gen2 → SCSI + NVMe if NVMe capability exists).
- Emits `accelNetMode` as `optional` or `unsupported`. If the size requires accelerated networking, adjust to `required` manually after generation.
- If `PremiumV2Supported` is not explicitly reported, a heuristic infers it from Premium IO + NVMe + Gen2.
- Output is formatted to match the indentation style used in `sizeOptions`.

Copy the emitted object and paste it into the appropriate family section in `sizeOptions`.

---

## VM Size Filtering UX

- The VM size section includes an optional filter panel.
- Filters can be added per capability (architecture, generation, controller, disk SKU support, accelerated networking, minimum max NICs, minimum max data disks).
- Active filters are shown as removable chips.
- If no sizes match, the UI shows: **"No VM size matches the filters."**

---

## Extra Options (Storage Overlay)

- The **Extra options** button in the header opens an overlay flow panel.
- Clicking outside the overlay panel (or pressing the toggle button again) closes it.
- The panel currently controls optional storage resources:
	- **Add SMB storage account + share**
	- **Add NFS storage account + share**
- Share name fields are shown only for enabled protocols.
- If neither SMB nor NFS is selected, no storage resources are added to the generated ARM.

---

## Validation and Output Gating

The UI blocks output actions when any of these fail:

- VM naming rules (format/uniqueness)
- NIC naming rules (format/uniqueness in VM)
- Data disk size/SKU validation
- VM-size attachment limits (`maxNics`, `maxDataDisks`)
- SMB/NFS share-name validation when protocol is enabled

When limits are hit:

- Add NIC/Add disk buttons are disabled
- limit-specific messages are shown
- copy/download/deploy actions are disabled until fixed

---

## Deployment Assist (Copy + Portal)

- Export actions are shown under **Generated ARM JSON** as: **Copy** | **Copy + Portal** | **Download**, with **Import JSON** aligned on the same action row.
- **Copy + Portal** does the following:
	1. Copies ARM JSON to clipboard
	2. Shows an inline warning/countdown near action buttons
	3. Waits `LIMITS.DEPLOY_COUNTDOWN_S` seconds (default 5)
	4. Opens Azure custom template page: `https://portal.azure.com/#create/Microsoft.Template`
- Warning text reminds users to allow pop-up windows if the portal does not open.

---

## Import JSON

- Click **Import JSON** to load a previously generated (or compatible) ARM template.
- The import parser (`importFromArmJson()`):
	- Extracts `Microsoft.Compute/virtualMachines` resources
	- Matches `vmSize` to `sizeOptions` catalog (case-insensitive)
	- Matches `imageReference` (publisher + offer + sku) to `imageOptions` catalog (case-insensitive)
	- Imports NICs: derives short name from full resource name, detects public IP and accelerated networking
	- Imports data disks: size and SKU (validated against `maxDiskSizeGbBySku`)
	- Clears custom data (encoding can't be reliably reversed)
- VMs whose size or image is not in the catalog are skipped.
- A summary toast reports imported count, skipped VMs, and custom data status.

---

## Custom Data Behavior

- Custom data text is base64-encoded directly for ARM `osProfile.customData`.
- Optional checkbox: **Reboot required after deployment** (UI state is preserved in configuration).

---

## Ultra Disk Behavior

- If any VM includes a data disk with `UltraSSD_LRS`:
  - `additionalCapabilities.ultraSSDEnabled` is set on that VM
  - a zonal placement parameter is used and VM/PIP are aligned to the selected zone.

---

## Accessibility

- **VM tab bar**: `role="tablist"` + `role="tab"` + `aria-selected`, with arrow-key navigation (Left/Right/Home/End).
- **Filter panel**: `role="dialog"` + `aria-modal="true"`, focus-trapped (Tab cycles inside), Escape to close and return focus.
- **Filter results**: `aria-live` region (`#sizeFilterLive`) announces matching size count when filters change.
- **Screen-reader-only** content uses `.sr-only` CSS class.

---

## State Persistence

- VM configuration, size filters, storage options, overlay open/close state, and active tab index are auto-saved to `localStorage` under key `armBuilderUiStateV1`.
- State is restored on page load via `loadUiState()`.
- Saved after every change via `saveUiState()` (called from `updateOutput()`).
- If localStorage is unavailable or corrupted, the app starts with defaults.

---

## Maintenance Guide

When changing this project:

1. Update catalogs first (`imageOptions`, `sizeOptions`).
2. Keep keys stable unless migration is intentional.
3. Ensure no duplicate image `key` or `ref` values.
4. After adding new images/sizes, page load validation will catch config errors.
5. Verify these scenarios manually:
	- size change causes image/controller auto-correction
	- filter chips and no-match state behave correctly
	- size hints hide/show correctly when filters exclude the current size
	- publisher filter updates image list correctly
	- duplicate VM names are blocked
	- NIC/data disk limits enforce correctly for each size
	- disk SKU coercion works after size changes
	- Copy + Portal shows warning/countdown and opens Azure portal (or shows clear pop-up guidance)
	- Import JSON loads valid templates and reports skipped VMs
	- localStorage persistence survives page reload
	- arrow-key tab navigation and filter panel focus trap work correctly
	- Extra options overlay closes when clicking outside the panel
	- generated ARM validates in portal/CLI

---

## Project Structure

Current design is intentionally simple and portable:

- `index.html` — UI, data catalogs, state management, and ARM generation logic
- `urn-to-imageoption.sh` — helper script to generate `imageOptions` entries from Azure image URNs
- `sku-to-sizeoption.sh` — helper script to generate `sizeOptions` entries from Azure VM SKU names
- `README.md` — this file
