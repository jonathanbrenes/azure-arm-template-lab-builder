# Changelog

All notable changes to this project are documented in this file.

## [1.0.9] - 2026-02-27
### Changed
- Updated public-facing README to reflect the current product release behavior and UX flows.
- Documented split/static delivery model clearly:
  - `index.html` as the split entry that loads external `styles.css` and JavaScript assets.
  - `index.static.html` as the single-file static variant.
- Added documentation for expanded JSON workspace behavior (maximize/minimize controls and mirrored output actions in expanded view).
- Added a new user-facing function map section in README for key runtime flows, including generation, output refresh, import, storage rendering, expanded JSON controls, and bootstrap lifecycle.
- Clarified deployment behavior that generated templates synchronize `/etc/hosts` on each VM with hostname/IP entries for all VMs created by the same ARM template deployment.
- Added the `/etc/hosts` synchronization note in both README sections where users look for behavior details (`UI Behavior` and `Import Behavior`).
- Removed internal-source/build references from README and kept documentation focused on public artifacts and user-visible outcomes.

## [1.0.8] - 2026-02-26
### Changed
- Updated README documentation to reflect the current shipped UX and deployment behavior introduced in recent releases.
- Clarified **Extra options** overlay guidance to include SMB/NFS toggles plus custom NSG rule management in one workflow.
- Updated docs for **Import JSON** to describe restored storage settings (SMB/NFS), imported custom NSG rules, and import summary messaging.
- Updated **Custom Data** documentation to describe shebang normalization, CRLF→LF normalization, optional delayed reboot append, and base64 encoding behavior.
- Updated validation/state persistence docs to include shared-disk validation and persisted custom NSG rules.

## [1.0.7] - 2026-02-26
### Added
- **Shared data disk workflow** across VMs (max 2 attachments per shared disk) with:
  - Enable/disable shared disk actions in the data disk UI.
  - Attach-existing-shared-disk flow from eligible VMs.
  - Shared disk assignment details, attachment counts, and participating VM names.
  - Shared disk ARM resource generation via `Microsoft.Compute/disks` with `maxShares: 2`.
- **Custom inbound NSG rules** in **Extra options**:
  - Add/remove rule rows for protocol (TCP/UDP), destination port/port range, and source (AzureCloud/Internet).
  - Generated NSG includes default SSH rule plus custom user-defined inbound allow rules.
- **Import JSON enhancements**:
  - Best-effort SMB/NFS share setting import.
  - Best-effort custom inbound NSG rule import (excluding default SSH rule).
  - Import summary now reports storage state and imported custom NSG rule count.

### Changed
- **Storage overlay UX** improved:
  - SMB/NFS share fields now use accessibility-friendly visibility behavior.
  - Overlay now combines storage toggles and custom NSG rule authoring.
- **Validation/output gating** strengthened:
  - Shared-disk configuration errors now block copy/download/deploy actions until fixed.
  - VM size changes that do not support shared disks automatically convert affected shared disks to normal disks with user feedback.
- **Deployment flow** preserved while expanded:
  - Output action layout remains **Copy | Copy + Portal | Download | Import JSON**.
  - Zonal placement logic now accounts for UltraSSD, PremiumV2, and qualifying shared-disk scenarios.
- **Custom data encoding behavior** hardened:
  - If custom data does not start with a shebang, `#!/bin/bash` is prepended before encoding.
  - Line endings are normalized before optional delayed reboot append and base64 encoding.
- Added RHEL HA 8.8 image option (`RedHat:RHEL-HA:8_8:latest`) to the image catalog.

### Fixed
- Shared disk clone safety: cloned VMs no longer inherit shared disk attachments, preventing unintended third-attachment scenarios.
- Imported data disks are normalized as non-shared in the UI model to avoid ambiguous shared-disk reconstruction.

## [1.0.6] - 2026-02-26
### Added
- **Optional SMB/NFS Azure Files storage** in a new **Extra options** overlay panel accessible from the header.
  - Independent protocol toggles: enable SMB, NFS, or both.
  - Per-protocol share name input fields with inline validation (3–63 chars, lowercase/numbers/hyphens, no consecutive hyphens).
  - ARM template conditionally generates storage accounts, file shares, private endpoints, private DNS zones/links, and mount-path outputs for enabled protocols only.
- **Storage Configuration Summary** section below the VM summary, visible only when at least one protocol is enabled.
- **Share name validation as output gating** — copy/download/deploy actions are disabled when an enabled share name is invalid.
- **Click-outside-to-close** behavior for the Extra options overlay panel.
- **Comprehensive JSDoc documentation** on all functions, covering parameters, return types, purpose, and cross-references.

### Changed
- `storageOptions` and `extraOptionsOpen` state are persisted to and restored from `localStorage`.
- Help balloon text updated to describe storage overlay and custom data encoding behavior.
- Import toast message simplified to "cleared during import".
- README updated with click-outside-to-close overlay behavior, JSDoc documentation feature, Extra Options dismiss documentation, and overlay dismiss verification step in Maintenance Guide.

## [1.0.5] - 2026-02-25
### Added
- Import JSON feature (`importFromArmJson`) to load an existing ARM template back into the UI.
- Accessibility improvements: ARIA `tablist`/`tab`/`tabpanel` roles, keyboard focus trap in modals, `aria-live` region for dynamic feedback.
- UI state persistence via `localStorage` (key `armBuilderUiStateV1`) so configuration survives page reloads.
- `sku-to-sizeoption.sh` utility script to generate `sizeOptions` entries from Azure VM SKU names via `az vm list-skus`.

### Changed
- Refactored global state into a centralized `state` object with `globalThis` property accessors.
- Extracted magic numbers into a frozen `LIMITS` constant object.
- Replaced bulk DOM re-renders with targeted render helpers for improved performance.
- Added per-cycle computation caching (`_imageCache`, `_dupVmNamesCache`) cleared by `invalidateCycleCaches()`.
- Redesigned output action buttons with `.btn-group` layout.
- Synchronized multi-filter panel state across UI components.
- Updated inline documentation: help balloon, maintenance guide, image catalog, and VM size catalog comments.
- Comprehensive README update covering architecture, helper scripts, accessibility, state persistence, and Import JSON.

### Fixed
- Fixed help balloon text appearing all bold due to `font-weight: 800` inheritance from `<header>`.
- Fixed XSS vulnerability in dynamic HTML rendering.
- Fixed shadow/styling bug on panel elements.
- Removed unused variables (`customDataB64`, `isPrimary`) from `importFromArmJson()`.

## [1.0.4] - 2026-02-24
### Added
- Added a new `Copy + Open Portal` action button next to Copy/Download in the JSON output actions.
- Added deployment-assist flow to copy ARM JSON, show an inline warning countdown, wait 5 seconds, and open `https://portal.azure.com/#create/Microsoft.Template`.

### Changed
- Updated deploy warning text to include explicit guidance to allow pop-up windows if the portal does not open.
- Standardized deploy-flow behavior and messaging across `index.html` and `arm builder.html`.

## [1.0.3] - 2026-02-24
### Added
- optional “Add VM filter” popup + active filter chips
- filter-aware VM size dropdown behavior
- Added VM size capability metadata and enforcement in `index.html` for `maxNics` and `maxDataDisks`.

### Changed
- Reduced visual emphasis of the VM filtering UI in `index.html` (smaller fonts/buttons/chips) so it remains clearly optional.
- Updated size hints in `index.html` to include max NIC and max data disk values when applicable.

### Fixed
- Prevented ARM JSON generation in `index.html` when VM size attachment limits are violated.
- Disabled Add NIC/Add disk actions at limit and surfaced limit-specific validation/toast feedback.

## [1.0.2] - 2026-02-24
### Added
- Added SLES 12 SP5 image mapping support to the image catalog.
- Added `urn-to-imageoption.sh` utility script to generate `imageOptions` entries from image URNs.

## [1.0.1] - 2026-02-24
### Fixed
- Updated VM clone naming behavior to avoid chained names like `vm1-clone-clone`.
- Clone names now use incremental numbering from the base VM name:
  - `vm1-clone-1`
  - `vm1-clone-2`
  - `vm1-clone-3`
- Added normalization so cloning works consistently even when the source VM already has a clone-style name.

## [1.0.0] - 2026-02-24
### Added
- Initial public upload of the Linux ARM Template UI.
- Single-file web app to build multi-VM ARM templates.
- VM configuration UI for:
  - VM size, generation, publisher, OS image, disk controller
  - NICs and public IP settings
  - Data disks and SKU selection
  - Optional custom data and reboot flag
- ARM JSON generation with copy/download actions.
- Compatibility enforcement and validation across image/size/controller constraints.
- Summary view and help guidance in the UI.
