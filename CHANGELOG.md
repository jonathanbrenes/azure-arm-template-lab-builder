# Changelog

All notable changes to this project are documented in this file.

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
