# Changelog

All notable changes to this project are documented in this file.

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
