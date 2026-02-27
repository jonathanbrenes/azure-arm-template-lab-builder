/*
   * =============================================================================
   * ARM Builder UI - Maintenance Guide
   * =============================================================================
   *
   * Purpose
   *   Build a multi-VM ARM template from a constrained UI model.
   *
   * High-level flow
   *   1) Static catalogs define capabilities:
   *      - imageOptions: OS image compatibility metadata (validated at startup)
   *      - sizeOptions: VM SKU capabilities (validated at startup)
   *   2) User edits active VM in the form.
   *   3) sanitizeAllVms() enforces constraints and auto-corrects invalid choices.
   *   4) updateOutput() regenerates ARM JSON + summary table.
   *   5) Copy/Download/Import exports or imports the generated template.
   *
   * Architecture notes
   *   - Global state is centralized in the `state` object with globalThis
   *     property accessors for backward compatibility (vms, active, sizeFilters).
   *   - UI state (VMs, filters, active tab) persists to localStorage under
   *     UI_STATE_STORAGE_KEY and is restored on page load via loadUiState().
   *   - Named constants live in the frozen LIMITS object (VM name length,
   *     Azure resource name limits, toast durations, default disk size, etc.).
   *   - Per-cycle caches (state._imageCache, state._dupVmNamesCache) avoid
   *     redundant computation within a single render/updateOutput cycle.
   *     Caches are invalidated by invalidateCycleCaches() at the start of
   *     render() and updateOutput().
   *
   * Render pipeline
   *   - render() is the full UI rebuild (tabs, selects, NICs, disks, hints).
   *     Used for tab switches, add/remove/clone VM, filter changes, initial load.
   *   - Targeted helpers avoid full DOM teardown for common interactions:
   *     - renderVmFormFields(vm): updates form field values (no DOM creation).
   *     - renderVmSelects(vm): repopulates gen/controller/publisher/image selects.
   *     - updateNicDiskButtons(vm): refreshes Add NIC / Add Disk disabled state.
   *     - updateNicNameConstraints(vm): patches NIC maxLength + errors in-place.
   *   - Event handlers call the minimum set of helpers needed for each action.
   *
   * Import
   *   - importFromArmJson() parses an ARM template, matches VM sizes and images
   *     to the catalogs, and builds VM models. Unrecognized sizes/images are
   *     skipped. Custom data is cleared on import.
   *
   * Accessibility
   *   - VM tab bar: role="tablist" + role="tab" + aria-selected + arrow keys.
   *   - Filter panel: role="dialog" + aria-modal + focus trap + Escape to close.
   *   - Filter results: aria-live region announces matching size count.
   *   - .sr-only class for visually hidden screen-reader content.
   *
   * Core invariants
   *   - VM names must be valid + unique.
   *   - Selected image must match VM size architecture + generation + controller.
   *   - Data disk SKUs must be supported by selected VM size.
   *   - Accelerated networking follows size policy (required/optional/unsupported).
   *   - Ultra disks trigger zonal placement + ultraSSDEnabled in generated ARM.
   *
   * Recommended maintenance workflow
   *   - Update imageOptions/sizeOptions from validated CLI output.
   *   - Keep keys stable for compatibility with saved configurations.
   *   - Verify UI behavior by changing size/gen/controller and observing auto-fixes.
   *   - After adding new images/sizes, run startup validation (page load checks).
   * =============================================================================
   */

  // ---------------------------------------------------------------------------
  // Utility helpers (ID generation, text encoding, customData conversion)
  // ---------------------------------------------------------------------------
  /**
   * Generates a short random hex string for use as a unique identifier.
   * Used to assign unique IDs to VMs, NICs, and other internal objects.
   * @returns {string} A random hex string (e.g. 'a3f9c1e2').
   */
  function uid() { return Math.random().toString(16).slice(2); }

  /**
   * Encodes a string as base64 using UTF-8 byte representation.
   * Works correctly with multi-byte characters (e.g. Unicode).
   * @param {string} text - The plain text to encode.
   * @returns {string} The base64-encoded string.
   */
  function toBase64Utf8(text) {
    const bytes = new TextEncoder().encode(String(text || ''));
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  /**
   * Encodes VM custom data for use in an ARM template's osProfile.customData field.
   * If the raw content does not start with a shebang line (e.g. #!/bin/bash),
   * one is automatically prepended so the script executes correctly at boot.
   * If {@link rebootRequired} is true, a delayed reboot command is appended to the
   * raw content before base64 encoding is applied.
   * @param {string} text - The raw custom data content.
   * @param {boolean} rebootRequired - Whether to append a delayed reboot command.
   * @returns {string} Base64-encoded string ready for ARM customData, or '' if empty.
   */
  function encodeCustomDataForArm(text, rebootRequired) {
    const raw = String(text || '');
    if (!raw.trim()) return '';
    const normalizedRaw = raw.replace(/\r\n/g, '\n');

    // Ensure the script has a shebang line. If the first line is not a shebang
    // (e.g. #!/bin/bash, #!/bin/sh, #!/usr/bin/env python3), prepend #!/bin/bash.
    const hasShebang = /^#!/.test(normalizedRaw.trimStart());
    const withShebang = hasShebang ? normalizedRaw : `#!/bin/bash\n${normalizedRaw}`;

    const payload = rebootRequired
      ? `${withShebang}\n\nsleep 60 && reboot &`
      : withShebang;
    return toBase64Utf8(payload);
  }
// ---------------------------------------------------------------------------
// UI feedback helper (small transient notifications for auto-fixes)
// ---------------------------------------------------------------------------
const UI_STATE_STORAGE_KEY = 'armBuilderUiStateV1';

// ---------------------------------------------------------------------------
// Named limits & magic-number constants (single source of truth)
// ---------------------------------------------------------------------------
const LIMITS = Object.freeze({
  VM_NAME_MAX_LEN:          64,   // Azure VM name character limit
  AZ_NETWORK_NAME_MAX_LEN:  80,   // Azure NIC / PIP resource name limit
  DEFAULT_DATA_DISK_GB:     128,  // Default size when adding a new data disk
  FALLBACK_MAX_DISK_GB:     32767,// Fallback max disk size (GiB) when SKU is unknown
  TOAST_DURATION_MS:        2600, // How long a toast notification stays visible
  COPY_FEEDBACK_MS:         900,  // How long "Copied!" label shows on the copy button
  DEPLOY_COUNTDOWN_S:       5,    // Seconds before auto-opening Azure portal
});

const state = {
  timers: {
    toast: null,
    deployFlow: null,
    deployFlowTick: null
  },
  sizeFilters: null,
  storageOptions: null,
  extraOptionsOpen: false,
  customNsgRules: [],
  vms: null,
  activeVmIndex: 0,
  // Per-cycle caches (invalidated at the start of each render/updateOutput cycle)
  _imageCache: null,
  _dupVmNamesCache: null
};
/**
 * Shows a transient toast notification at the bottom-right of the viewport.
 * Automatically hides after {@link LIMITS.TOAST_DURATION_MS} milliseconds.
 * Used to inform users of auto-corrections, import results, and limit warnings.
 * @param {string} title - Bold heading text for the toast.
 * @param {string} msg - Descriptive body text.
 */
function showToast(title, msg) {
  const t = document.getElementById('toast');
  const tt = document.getElementById('toastTitle');
  const tm = document.getElementById('toastMsg');
  if (!t || !tt || !tm) return;
  tt.textContent = title || '';
  tm.textContent = msg || '';
  t.classList.add('show');
  if (state.timers.toast) clearTimeout(state.timers.toast);
  state.timers.toast = setTimeout(() => t.classList.remove('show'), LIMITS.TOAST_DURATION_MS);
}

/**
 * Shows an inline deployment warning/countdown near the output action buttons.
 * Displays a countdown timer that ticks every second before auto-opening the
 * Azure portal custom deployment page. The panel auto-hides when the countdown finishes.
 * @param {string} msg - Instructional text shown in the deploy flow panel.
 * @param {number} seconds - Countdown duration in seconds (defaults to {@link LIMITS.DEPLOY_COUNTDOWN_S}).
 */
function showDeployFlow(msg, seconds) {
  const panel = document.getElementById('deployFlowInline');
  const title = document.getElementById('deployFlowInlineTitle');
  const body = document.getElementById('deployFlowInlineMsg');
  if (!panel || !title || !body) return;

  let remaining = Math.max(1, Number(seconds || LIMITS.DEPLOY_COUNTDOWN_S));
  title.textContent = `Warning: opening Azure portal in ${remaining}s`;
  body.textContent = msg || '';
  panel.classList.add('show');

  if (state.timers.deployFlowTick) clearInterval(state.timers.deployFlowTick);
  state.timers.deployFlowTick = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(state.timers.deployFlowTick);
      state.timers.deployFlowTick = null;
      return;
    }
    title.textContent = `Warning: opening Azure portal in ${remaining}s`;
  }, 1000);

  if (state.timers.deployFlow) clearTimeout(state.timers.deployFlow);
  state.timers.deployFlow = setTimeout(() => {
    panel.classList.remove('show');
    if (state.timers.deployFlowTick) {
      clearInterval(state.timers.deployFlowTick);
      state.timers.deployFlowTick = null;
    }
  }, remaining * 1000);
}

// ---------------------------------------------------------------------------
// Image catalog (source-of-truth for image compatibility constraints)
// ---------------------------------------------------------------------------
// Notes:
// - `key` must be unique (validated at startup by validateImageOptionsConfig()).
// - `arch` + `gen` + controller flags drive UI filtering via filteredImages().
// - `ref` is written directly to ARM imageReference, and is also the key used
//   by importFromArmJson() to match imported ARM VMs back to catalog entries
//   (publisher + offer + sku, case-insensitive).
// - Results of filteredImages() are cached per render cycle in
//   state._imageCache to avoid redundant array scans.
// - Keep entries grouped by publisher and sorted by key for easier diffs.
//
// Why we keep multiple images per distro:
// - Architecture: x64 and Arm64 require different image SKUs.
// - Release track: courses/labs may need specific OS major/minor lines.
// - VM Generation: Gen1 vs Gen2 image compatibility differs by VM size/family.
// - Disk controller: some Gen2/size combinations require NVMe-capable images.
//
// Organization policy:
// - Group by publisher in this order: RedHat, Canonical, SUSE.
// - Within each publisher, keep entries ordered by `key` for maintenance.
  const imageOptions = globalThis.ARM_BUILDER_IMAGE_OPTIONS || [];

  const imageSortCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const imagePublisherOrder = new Map();
  imageOptions.forEach((img) => {
    const publisher = String((img.ref && img.ref.publisher) || '').trim();
    if (publisher && !imagePublisherOrder.has(publisher)) {
      imagePublisherOrder.set(publisher, imagePublisherOrder.size);
    }
  });
  imageOptions.sort((a, b) => {
    const ap = String((a.ref && a.ref.publisher) || '');
    const bp = String((b.ref && b.ref.publisher) || '');
    const apr = imagePublisherOrder.get(ap) ?? Number.MAX_SAFE_INTEGER;
    const bpr = imagePublisherOrder.get(bp) ?? Number.MAX_SAFE_INTEGER;
    if (apr !== bpr) return apr - bpr;

    const ak = String(a.key || '');
    const bk = String(b.key || '');
    const byKey = imageSortCollator.compare(ak, bk);
    if (byKey !== 0) return byKey;

    const al = String(a.label || '');
    const bl = String(b.label || '');
    return imageSortCollator.compare(al, bl);
  });

  /**
   * Validates the imageOptions catalog at startup.
   * Checks that every image entry has a unique `key` and a unique `ref`
   * (publisher:offer:sku:version). Throws an Error with a detailed list
   * of issues if any duplicates or missing fields are found.
   * Called once on page load — if this throws, the UI will not start.
   * @param {Array<Object>} options - The imageOptions array to validate.
   * @throws {Error} If any image key or ref is duplicated or missing.
   */
  function validateImageOptionsConfig(options) {
    const keySeen = new Map();
    const refSeen = new Map();
    const issues = [];

    options.forEach((img, idx) => {
      const key = String(img && img.key || '').trim();
      const ref = img && img.ref ? img.ref : {};
      const refId = [ref.publisher, ref.offer, ref.sku, ref.version].map(v => String(v || '').trim()).join(':');

      if (!key) {
        issues.push(`imageOptions[${idx}] is missing key`);
      } else if (keySeen.has(key)) {
        issues.push(`Duplicate image key '${key}' at indexes ${keySeen.get(key)} and ${idx}`);
      } else {
        keySeen.set(key, idx);
      }

      if (refId === ':::') {
        issues.push(`imageOptions[${idx}] has incomplete ref`);
      } else if (refSeen.has(refId)) {
        issues.push(`Duplicate image ref '${refId}' at indexes ${refSeen.get(refId)} and ${idx}`);
      } else {
        refSeen.set(refId, idx);
      }
    });

    if (issues.length) {
      const msg = `Invalid imageOptions configuration:\n- ${issues.join('\n- ')}`;
      console.error(msg);
      throw new Error(msg);
    }
  }

  validateImageOptionsConfig(imageOptions);

  // ---------------------------------------------------------------------------
  // VM size catalog (source-of-truth for size-level capabilities)
  // ---------------------------------------------------------------------------
  // Notes:
  // - Each entry is validated at startup by validateSizeOptionsConfig().
  // - `name` must be unique and is matched case-insensitively by
  //   importFromArmJson() when importing ARM templates.
  // - `tags.architectures` constrains which images are compatible.
  // - `tags.generations` constrains VM generation selection.
  // - `tags.diskControllersByGen` constrains controller selection by generation.
  // - `tags.diskSkuSupport` gates allowed data disk SKUs in the UI.
  // - `tags.sharedDiskSupported` is informational only and must be verified
  //   manually. Azure CLI (`az vm list-skus`) often does not return a reliable
  //   SharedDiskSupported capability value.
  // - `tags.accelNetMode` controls NIC accelerated networking behavior
  //   ('required' | 'optional' | 'unsupported').
  // - `tags.ephemeralOsDiskSupported` is used by the size filter panel.
  // - `tags.maxNics` and `tags.maxDataDisks` enforce attachment limits.
  // - The multi-filter panel (sizeFilterMeta) filters this array via
  //   sizeMatchesFilters() across 9 dimensions: family, arch, gen,
  //   controller, diskSku, accel, ephemeral, minNics, minDataDisks.
  const sizeOptions = globalThis.ARM_BUILDER_SIZE_OPTIONS || [];

const maxDiskSizeGbBySku = {
  // Managed disk max sizes (GiB) aligned to common Azure limits.
  // Keep this object as the single source of truth for supported data disk SKUs.
  StandardSSD_LRS: 32767,
  Premium_LRS: 32767,
  PremiumV2_LRS: 65536,
  Standard_LRS: 32767,
  UltraSSD_LRS: 65536
};
const diskSkus = Object.keys(maxDiskSizeGbBySku);

/**
 * Extracts the VM size family letter prefix from an Azure SKU name.
 * For example, 'Standard_D4s_v5' returns 'D', 'Standard_E2bds_v5' returns 'E'.
 * Used for the 'Family' filter dimension in the VM size filter panel.
 * @param {string} name - The Azure VM size name (e.g. 'Standard_D4s_v5').
 * @returns {string} The uppercase family letter(s), or '' if not recognized.
 */
function sizeFamilyForName(name) {
  const raw = String(name || '');
  const m = raw.match(/^Standard_([A-Za-z]+)\d/i);
  if (m && m[1]) return m[1].toUpperCase();
  return '';
}

const sizeFamilyValues = Array.from(
  new Set(sizeOptions.map(s => sizeFamilyForName(s && s.name)).filter(Boolean))
).sort((a, b) => String(a).localeCompare(String(b)));

state.sizeFilters = {
  family: '',
  arch: '',
  gen: '',
  controller: '',
  diskSku: '',
  accel: '',
  ephemeral: '',
  minNics: '',
  minDataDisks: ''
};

/**
 * Returns the default storage configuration object.
 * Both SMB and NFS are disabled by default. Share names use sensible defaults.
 * @returns {{smbEnabled: boolean, nfsEnabled: boolean, smbShareName: string, nfsShareName: string}}
 */
function defaultStorageOptions() {
  return {
    smbEnabled: false,
    nfsEnabled: false,
    smbShareName: 'smbshare',
    nfsShareName: 'nfsshare',
  };
}

/**
 * Normalizes an Azure Files share name to meet naming constraints.
 * Lowercases, strips invalid characters, trims edge hyphens, and pads
 * to at least 3 characters. Truncates to 63 characters max.
 * @param {string} name - The raw share name input.
 * @param {string} fallback - Fallback name if the result is empty after normalization.
 * @returns {string} A normalized, valid share name.
 */
function normalizeShareName(name, fallback) {
  let value = String(name || '').trim().toLowerCase();
  value = value.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!value) value = String(fallback || 'share');
  if (value.length < 3) value = (value + '---').slice(0, 3);
  if (value.length > 63) value = value.slice(0, 63).replace(/-+$/g, '');
  if (!value) value = String(fallback || 'share');
  return value;
}

/**
 * Normalizes a raw storage options object into a complete, valid configuration.
 * Fills in missing fields with defaults from {@link defaultStorageOptions}.
 * Handles backward compatibility with a legacy top-level `enabled` toggle.
 * @param {Object} raw - The raw storage options object (may be incomplete or null).
 * @returns {Object} A fully populated storage options object.
 */
function normalizeStorageOptions(raw) {
  const next = defaultStorageOptions();
  if (!raw || typeof raw !== 'object') return next;

  // Backward compatibility: previous UI had a top-level enabled toggle.
  // If it was explicitly disabled and per-protocol toggles are not provided,
  // keep both protocols off.
  const legacyEnabled = (raw.enabled !== undefined) ? !!raw.enabled : undefined;

  if (raw.smbEnabled !== undefined) next.smbEnabled = !!raw.smbEnabled;
  if (raw.nfsEnabled !== undefined) next.nfsEnabled = !!raw.nfsEnabled;

  if (legacyEnabled === false && raw.smbEnabled === undefined && raw.nfsEnabled === undefined) {
    next.smbEnabled = false;
    next.nfsEnabled = false;
  }

  if (raw.smbShareName !== undefined) next.smbShareName = String(raw.smbShareName);
  if (raw.nfsShareName !== undefined) next.nfsShareName = String(raw.nfsShareName);
  return next;
}

/**
 * Validates an Azure Files share name against Azure naming rules:
 * 3–63 characters, lowercase letters/numbers/hyphens only, must start and end
 * with a letter or number, no consecutive hyphens ('--').
 * @param {string} name - The share name to validate.
 * @param {string} label - A human-readable label for error messages (e.g. 'SMB' or 'NFS').
 * @returns {string} An error message string, or '' if the name is valid.
 */
function storageShareNameError(name, label) {
  const raw = String(name || '').trim();
  if (!raw) return `${label} share name is required.`;
  if (raw.length < 3 || raw.length > 63) return `${label} share name must be 3-63 characters.`;
  if (!/^[a-z0-9-]+$/.test(raw)) return `${label} share name can use lowercase letters, numbers, and hyphen only.`;
  if (!/^[a-z0-9].*[a-z0-9]$/.test(raw)) return `${label} share name must start and end with a letter or number.`;
  if (raw.includes('--')) return `${label} share name cannot contain consecutive hyphens.`;
  return '';
}

/**
 * Returns validation error messages for both SMB and NFS share names.
 * Only validates share names for protocols that are currently enabled.
 * @returns {{smb: string, nfs: string}} An object with error strings ('' if valid).
 */
function storageShareErrors() {
  const cfg = normalizeStorageOptions(state.storageOptions);
  return {
    smb: cfg.smbEnabled ? storageShareNameError(cfg.smbShareName, 'SMB') : '',
    nfs: cfg.nfsEnabled ? storageShareNameError(cfg.nfsShareName, 'NFS') : ''
  };
}

/**
 * Checks whether any enabled storage protocol has a share name validation error.
 * Used by {@link updateOutput} to gate ARM output generation.
 * @returns {boolean} True if at least one enabled share name is invalid.
 */
function hasAnyStorageValidationErrors() {
  const errs = storageShareErrors();
  return !!(errs.smb || errs.nfs);
}

state.storageOptions = defaultStorageOptions();

const sizeFilterMeta = {
  family: { label: 'Family', values: sizeFamilyValues },
  arch: { label: 'Architecture', values: ['x64', 'Arm64'] },
  gen: { label: 'Generation', values: ['Gen1', 'Gen2'] },
  controller: { label: 'Disk controller', values: ['SCSI', 'NVMe'] },
  diskSku: { label: 'Disk SKU support', values: diskSkus },
  accel: { label: 'Accelerated networking', values: ['required', 'optional', 'unsupported'], valueLabels: { required: 'Required', optional: 'Optional', unsupported: 'Unsupported' } },
  ephemeral: { label: 'Ephemeral OS disk', values: ['supported', 'not-supported'], valueLabels: { supported: 'Supported', 'not-supported': 'Not supported' } },
  minNics: { label: 'Min max NICs', values: ['1', '2', '3', '4', '8', '16'] },
  minDataDisks: { label: 'Min max data disks', values: ['1', '2', '4', '8', '16', '32'] }
};

/**
 * Validates the sizeOptions catalog at startup.
 * Checks that every VM size entry has a unique `name`, valid `tags` structure
 * (architectures, generations, diskControllersByGen, diskSkuSupport, accelNetMode,
 * sharedDiskSupported, maxNics, maxDataDisks), and no unknown enum values.
 * Throws an Error with a
 * detailed list of issues if any problems are found.
 * Called once on page load — if this throws, the UI will not start.
 * @param {Array<Object>} options - The sizeOptions array to validate.
 * @throws {Error} If any size name is duplicated or tags are invalid/incomplete.
 */
function validateSizeOptionsConfig(options) {
  const allowedArchitectures = new Set(['x64', 'Arm64']);
  const allowedGenerations = new Set(['Gen1', 'Gen2']);
  const allowedControllers = new Set(['SCSI', 'NVMe']);
  const allowedAccelModes = new Set(['required', 'optional', 'unsupported']);
  const expectedDiskSkus = new Set(diskSkus);

  const nameSeen = new Map();
  const issues = [];

  const isPositiveInteger = (v) => Number.isInteger(v) && v > 0;

  options.forEach((size, idx) => {
    const name = String(size && size.name || '').trim();
    const tags = size && size.tags ? size.tags : null;

    if (!name) {
      issues.push(`sizeOptions[${idx}] is missing name`);
    } else if (nameSeen.has(name)) {
      issues.push(`Duplicate size name '${name}' at indexes ${nameSeen.get(name)} and ${idx}`);
    } else {
      nameSeen.set(name, idx);
    }

    if (!tags || typeof tags !== 'object') {
      issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) is missing tags object`);
      return;
    }

    const architectures = Array.isArray(tags.architectures) ? tags.architectures : [];
    if (!architectures.length) {
      issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) must define at least one architecture`);
    } else {
      architectures.forEach((arch) => {
        if (!allowedArchitectures.has(String(arch))) {
          issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) has unsupported architecture '${arch}'`);
        }
      });
    }

    const generations = Array.isArray(tags.generations) ? tags.generations : [];
    if (!generations.length) {
      issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) must define at least one generation`);
    } else {
      generations.forEach((gen) => {
        if (!allowedGenerations.has(String(gen))) {
          issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) has unsupported generation '${gen}'`);
        }
      });
    }

    const controllerMap = (tags.diskControllersByGen && typeof tags.diskControllersByGen === 'object') ? tags.diskControllersByGen : null;
    if (!controllerMap) {
      issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) is missing diskControllersByGen`);
    } else {
      Object.keys(controllerMap).forEach((genKey) => {
        if (!allowedGenerations.has(genKey)) {
          issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) has unknown diskControllersByGen key '${genKey}'`);
          return;
        }
        const controllers = controllerMap[genKey];
        if (!Array.isArray(controllers) || controllers.length === 0) {
          issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) must define at least one controller for ${genKey}`);
          return;
        }
        controllers.forEach((ctl) => {
          if (!allowedControllers.has(String(ctl))) {
            issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) has unsupported controller '${ctl}' for ${genKey}`);
          }
        });
      });

      generations.forEach((gen) => {
        if (!Array.isArray(controllerMap[gen]) || controllerMap[gen].length === 0) {
          issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) is missing disk controller mapping for ${gen}`);
        }
      });
    }

    const diskSupport = (tags.diskSkuSupport && typeof tags.diskSkuSupport === 'object') ? tags.diskSkuSupport : null;
    if (!diskSupport) {
      issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) is missing diskSkuSupport`);
    } else {
      expectedDiskSkus.forEach((sku) => {
        if (typeof diskSupport[sku] !== 'boolean') {
          issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) diskSkuSupport.${sku} must be boolean`);
        }
      });

      Object.keys(diskSupport).forEach((sku) => {
        if (!expectedDiskSkus.has(sku)) {
          issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) has unknown diskSkuSupport key '${sku}'`);
        }
      });
    }

    if (!allowedAccelModes.has(String(tags.accelNetMode || ''))) {
      issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) has invalid accelNetMode '${tags.accelNetMode}'`);
    }

    if (!isPositiveInteger(Number(tags.maxNics))) {
      issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) maxNics must be a positive integer`);
    }

    if (!isPositiveInteger(Number(tags.maxDataDisks))) {
      issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) maxDataDisks must be a positive integer`);
    }

    if (tags.ephemeralOsDiskSupported !== undefined && typeof tags.ephemeralOsDiskSupported !== 'boolean') {
      issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) ephemeralOsDiskSupported must be boolean when provided`);
    }

    if (tags.sharedDiskSupported !== undefined && typeof tags.sharedDiskSupported !== 'boolean') {
      issues.push(`sizeOptions[${idx}] (${name || 'unknown'}) sharedDiskSupported must be boolean when provided`);
    }
  });

  if (issues.length) {
    const msg = `Invalid sizeOptions configuration:\n- ${issues.join('\n- ')}`;
    console.error(msg);
    throw new Error(msg);
  }
}

validateSizeOptionsConfig(sizeOptions);

  // ---------------------------------------------------------------------------
  // View-model defaults and lookup helpers
  // ---------------------------------------------------------------------------
  /**
   * Creates a default NIC model object with a sequential name.
   * The first NIC (index 0) gets a public IP by default; subsequent NICs do not.
   * @param {number} idx - Zero-based NIC index within the VM.
   * @returns {{id: string, name: string, accelerated: boolean, publicIp: boolean}}
   */
  function defaultNic(idx) {
    return { id: uid(), name: `nic${idx+1}`, accelerated: false, publicIp: idx === 0 };
  }

  /**
   * Looks up a VM size entry by name from the sizeOptions catalog.
   * Falls back to the first entry if not found (defensive default).
   * @param {string} name - The Azure VM size name (e.g. 'Standard_D4s_v5').
   * @returns {Object} The matching sizeOptions entry.
   */
  function sizeByName(name) {
    return sizeOptions.find(s => s.name === name) || sizeOptions[0];
  }

  /**
   * Tests whether a VM size matches all currently active size filters.
   * Evaluates up to 9 filter dimensions: family, architecture, generation,
   * disk controller, disk SKU support, accelerated networking, ephemeral
   * OS disk support, minimum NICs, and minimum data disks.
   * @param {Object} size - A sizeOptions entry with `name` and `tags`.
   * @returns {boolean} True if the size matches all active filters (or no filters are set).
   */
  function sizeMatchesFilters(size) {
    const tags = (size && size.tags) || {};
    const family = sizeFamilyForName(size && size.name);
    const archs = tags.architectures || [];
    const gens = tags.generations || [];
    const ctlMap = tags.diskControllersByGen || {};
    const diskSupport = tags.diskSkuSupport || {};
    const accel = String(tags.accelNetMode || (tags.accelNet ? 'optional' : 'unsupported'));
    const ephemeral = !!tags.ephemeralOsDiskSupported;
    const maxNics = Number(tags.maxNics || 0);
    const maxDataDisks = Number(tags.maxDataDisks || 0);

    if (sizeFilters.family && family !== sizeFilters.family) return false;
    if (sizeFilters.arch && !archs.includes(sizeFilters.arch)) return false;
    if (sizeFilters.gen && !gens.includes(sizeFilters.gen)) return false;
    if (sizeFilters.controller) {
      const hasController = Object.values(ctlMap).some(arr => Array.isArray(arr) && arr.includes(sizeFilters.controller));
      if (!hasController) return false;
    }
    if (sizeFilters.diskSku && !diskSupport[sizeFilters.diskSku]) return false;
    if (sizeFilters.accel && accel !== sizeFilters.accel) return false;
    if (sizeFilters.ephemeral === 'supported' && !ephemeral) return false;
    if (sizeFilters.ephemeral === 'not-supported' && ephemeral) return false;
    if (sizeFilters.minNics && maxNics < Number(sizeFilters.minNics)) return false;
    if (sizeFilters.minDataDisks && maxDataDisks < Number(sizeFilters.minDataDisks)) return false;

    return true;
  }

  /**
   * Returns the subset of sizeOptions that match all currently active size filters.
   * @returns {Array<Object>} Filtered array of size entries.
   */
  function filteredSizeOptions() {
    return sizeOptions.filter(sizeMatchesFilters);
  }

  /**
   * Checks whether a specific VM size is excluded by the current filters.
   * Used to show a hint when the active VM's size doesn't match the filter set.
   * @param {string} sizeName - The VM size name to check.
   * @returns {boolean} True if the size does NOT match current filters.
   */
  function sizeIsOutsideFilters(sizeName) {
    const size = sizeByName(sizeName);
    return !sizeMatchesFilters(size);
  }

  /**
   * Generates the next available default VM name (e.g. 'vm1', 'vm2', 'vm3').
   * Skips names already in use in the global `vms` array.
   * @returns {string} An unused VM name like 'vm<N>'.
   */
  function nextDefaultVmName() {
    const used = new Set(vms.map(v => String(v.name || '').trim().toLowerCase()).filter(Boolean));
    let n = 1;
    while (used.has(`vm${n}`.toLowerCase())) n += 1;
    return `vm${n}`;
  }

  /**
   * Generates the next available default NIC name within a VM (e.g. 'nic1', 'nic2').
   * Skips names already in use in the VM's NIC list.
   * @param {Object} vm - The VM model whose NICs are checked.
   * @returns {string} An unused NIC name like 'nic<N>'.
   */
  function nextDefaultNicName(vm) {
    const used = new Set((vm.nics || []).map(n => String((n && n.name) || '').trim().toLowerCase()).filter(Boolean));
    let n = 1;
    while (used.has(`nic${n}`.toLowerCase())) n += 1;
    return `nic${n}`;
  }

  /**
   * Generates the next available clone VM name based on a source VM name.
   * Strips any existing '-clone-N' suffixes, then appends '-clone-1', '-clone-2', etc.
   * Skips names already in use in the global `vms` array.
   * @param {string} sourceName - The name of the VM being cloned.
   * @returns {string} A unique clone name like 'vm1-clone-1'.
   */
  function nextCloneVmName(sourceName) {
    const used = new Set(vms.map(v => String(v.name || '').trim().toLowerCase()).filter(Boolean));
    let base = String(sourceName || 'vm').trim() || 'vm';

    // Normalize sources like "vm1-clone", "vm1-clone-2", or legacy "vm1-clone-clone".
    while (/-clone(?:-\d+)?$/i.test(base)) {
      base = base.replace(/-clone(?:-\d+)?$/i, '');
    }
    if (!base) base = 'vm';

    let n = 1;
    let candidate = `${base}-clone-${n}`;
    while (used.has(candidate.toLowerCase())) {
      n += 1;
      candidate = `${base}-clone-${n}`;
    }

    return candidate;
  }

  /**
   * Returns a Set of lowercased VM names that appear more than once.
   * Result is cached per render cycle in `state._dupVmNamesCache` and
   * invalidated by {@link invalidateCycleCaches}.
   * @returns {Set<string>} Lowercased names that are duplicates.
   */
  function duplicateVmNamesSet() {
    if (state._dupVmNamesCache) return state._dupVmNamesCache;
    const counts = new Map();
    vms.forEach(vm => {
      const k = String((vm && vm.name) || '').trim().toLowerCase();
      if (!k) return;
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    const dupes = new Set();
    counts.forEach((count, key) => {
      if (count > 1) dupes.add(key);
    });
    state._dupVmNamesCache = dupes;
    return dupes;
  }

  /**
   * Checks whether the VM at a given index shares its name with another VM.
   * @param {number} index - The index into the global `vms` array.
   * @returns {boolean} True if this VM's name is a duplicate.
   */
  function hasDuplicateVmNameAt(index) {
    const vm = vms[index];
    if (!vm) return false;
    const key = String(vm.name || '').trim().toLowerCase();
    if (!key) return false;
    return duplicateVmNamesSet().has(key);
  }

  /**
   * Validates a VM name against Azure naming rules.
   * Must be 1–{@link LIMITS.VM_NAME_MAX_LEN} characters, only letters/numbers/hyphens,
   * and must start and end with a letter or number.
   * @param {string} name - The VM name to validate.
   * @returns {string} An error message, or '' if the name is valid.
   */
  function vmNameFormatError(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return 'VM name is required.';
    if (trimmed.length > LIMITS.VM_NAME_MAX_LEN) return `VM name must be 1-${LIMITS.VM_NAME_MAX_LEN} characters.`;
    const innerMax = LIMITS.VM_NAME_MAX_LEN - 2; // regex inner repetition
    const re = new RegExp(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,${innerMax}}[A-Za-z0-9])?$`);
    if (!re.test(trimmed)) {
      return `VM name must be 1-${LIMITS.VM_NAME_MAX_LEN} chars, use letters/numbers/hyphen only, and start/end with letter or number.`;
    }
    return '';
  }

  /**
   * Returns a composite error message for the VM at the given index.
   * Checks format validity first, then uniqueness across all VMs.
   * @param {number} index - The index into the global `vms` array.
   * @returns {string} An error message, or '' if the VM name is valid and unique.
   */
  function vmNameErrorAt(index) {
    const vm = vms[index];
    if (!vm) return '';
    const formatErr = vmNameFormatError(vm.name);
    if (formatErr) return formatErr;
    if (hasDuplicateVmNameAt(index)) return 'VM name must be unique. Use a different name.';
    return '';
  }

  /**
   * Checks whether any VM in the global `vms` array has a name error (format or duplicate).
   * Used by {@link updateOutput} to gate ARM output generation.
   * @returns {boolean} True if at least one VM has a name error.
   */
  function hasAnyVmNameErrors() {
    return vms.some((_, i) => !!vmNameErrorAt(i));
  }

  /**
   * Computes the maximum allowed NIC name length given a VM name.
   * The NIC resource name in ARM is `<vmName>-<nicName>`, and the PIP name
   * is `<vmName>-<nicName>-pip`. Both must fit within {@link LIMITS.AZ_NETWORK_NAME_MAX_LEN}.
   * @param {string} vmName - The parent VM name.
   * @returns {number} Maximum character length for the NIC name (minimum 1).
   */
  function nicNameMaxLengthForVmName(vmName) {
    // NIC name contributes to both:
    // - NIC resource: <vm_name>-<nic_name>
    // - PIP resource: <vm_name>-<nic_name>-pip
    // PIP is stricter: vm + 1 + nic + 4 <= 80  => nic <= 75 - vm
    const vmLen = String(vmName || '').trim().length;
    return Math.max(1, LIMITS.AZ_NETWORK_NAME_MAX_LEN - vmLen - 5);
  }

  /**
   * Validates a NIC name against Azure resource naming rules.
   * The full resource name in ARM is `<vmName>-<nicName>` (and `<vmName>-<nicName>-pip`
   * for public IPs), so the NIC name max length depends on the VM name length.
   * @param {string} vmName - The parent VM name (used for length calculation).
   * @param {string} nicName - The NIC name to validate.
   * @returns {string} An error message, or '' if the NIC name is valid.
   */
  function nicNameFormatError(vmName, nicName) {
    const trimmed = String(nicName || '').trim();
    if (!trimmed) return 'NIC name is required.';

    const maxLen = nicNameMaxLengthForVmName(vmName);
    if (trimmed.length > maxLen) {
      return `NIC name is too long for this VM name. Max ${maxLen} chars so '${vmName}-${trimmed}' and '${vmName}-${trimmed}-pip' stay within ${LIMITS.AZ_NETWORK_NAME_MAX_LEN} chars.`;
    }

    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(trimmed)) {
      return 'NIC name can use letters, numbers, and hyphen only, and must start/end with letter or number.';
    }

    return '';
  }

  /**
   * Returns a Set of lowercased NIC names that appear more than once within a VM.
   * @param {Object} vm - The VM model whose NICs are checked.
   * @returns {Set<string>} Lowercased NIC names that are duplicates.
   */
  function duplicateNicNamesSet(vm) {
    const counts = new Map();
    (vm.nics || []).forEach(nic => {
      const key = String((nic && nic.name) || '').trim().toLowerCase();
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const dupes = new Set();
    counts.forEach((count, key) => {
      if (count > 1) dupes.add(key);
    });
    return dupes;
  }

  /**
   * Returns a composite error message for a specific NIC on a VM.
   * Checks format validity first, then uniqueness within the VM's NIC list.
   * @param {Object} vm - The parent VM model object.
   * @param {Object} nic - The NIC object to validate.
   * @returns {string} An error message, or '' if the NIC name is valid and unique.
   */
  function nicNameError(vm, nic) {
    const formatErr = nicNameFormatError(vm.name, nic.name);
    if (formatErr) return formatErr;

    const key = String((nic && nic.name) || '').trim().toLowerCase();
    if (!key) return 'NIC name is required.';
    if (duplicateNicNamesSet(vm).has(key)) return 'NIC name must be unique inside the VM.';

    return '';
  }

  /**
   * Checks whether any NIC across all VMs has a name error (format or duplicate).
   * Used by {@link updateOutput} to gate ARM output generation.
   * @returns {boolean} True if at least one NIC has a name error.
   */
  function hasAnyNicNameErrors() {
    return vms.some(vm => (vm.nics || []).some(nic => !!nicNameError(vm, nic)));
  }

  /**
   * Validates a data disk's size against its SKU's maximum.
   * Size must be a finite number > 1 GB and <= the max for the disk's SKU.
   * @param {Object} disk - A data disk object with `sizeGB` and `sku` properties.
   * @returns {string} An error message, or '' if the disk configuration is valid.
   */
  function diskSizeError(disk) {
    const size = Number(disk && disk.sizeGB);
    const sku = String((disk && disk.sku) || '');
    const maxSize = maxDiskSizeGbBySku[sku] || LIMITS.FALLBACK_MAX_DISK_GB;

    if (!Number.isFinite(size) || size <= 1) {
      return 'Data disk size must be greater than 1 GB.';
    }
    if (size > maxSize) {
      return `Data disk size exceeds limit for ${sku || 'selected SKU'}. Max ${maxSize} GB.`;
    }
    return '';
  }

  /**
   * Checks whether any data disk across all VMs has a size validation error.
   * Used by {@link updateOutput} to gate ARM output generation.
   * @returns {boolean} True if at least one data disk has an invalid size.
   */
  function hasAnyDiskValidationErrors() {
    return vms.some(vm => (vm.disks || []).some(d => !!diskSizeError(d)));
  }

  /**
   * Returns the list of VM generations supported by the VM's current size.
   * @param {Object} vm - A VM model object with a `size` property.
   * @returns {string[]} Allowed generations (e.g. ['Gen1', 'Gen2']).
   */
  function allowedGenerationsFor(vm) {
    return sizeByName(vm.size).tags.generations;
  }

  /**
   * Returns the list of CPU architectures supported by the VM's current size.
   * Falls back to ['x64'] if the size has no architecture tags.
   * @param {Object} vm - A VM model object with a `size` property.
   * @returns {string[]} Allowed architectures (e.g. ['x64'] or ['Arm64']).
   */
  function allowedArchitecturesFor(vm) {
    const sz = sizeByName(vm.size);
    return (sz.tags && sz.tags.architectures && sz.tags.architectures.length) ? sz.tags.architectures : ['x64'];
  }

  /**
   * Looks up an image entry from the imageOptions catalog by its unique key.
   * @param {string} key - The image key to search for.
   * @returns {Object|undefined} The matching imageOptions entry, or undefined.
   */
  function imageByKey(key) {
    return imageOptions.find(i => i.key === key);
  }

  /**
   * Returns the list of disk controllers allowed for the VM's current size and generation.
   * Falls back to ['SCSI'] if no mapping exists for the active generation.
   * @param {Object} vm - A VM model object with `size` and `gen` properties.
   * @returns {string[]} Allowed controllers (e.g. ['SCSI'], ['NVMe'], or ['SCSI', 'NVMe']).
   */
  function allowedControllersFor(vm) {
  const sz = sizeByName(vm.size);
  const map = (sz.tags && sz.tags.diskControllersByGen) ? sz.tags.diskControllersByGen : {};
  return map[vm.gen] || ['SCSI'];
}
/**
 * Checks whether accelerated networking is supported (optional or required) for a VM's size.
 * @param {Object} vm - A VM model object with a `size` property.
 * @returns {boolean} True if accel net is 'optional' or 'required'.
 */
function accelNetSupportedFor(vm) {
    return accelNetModeFor(vm) !== 'unsupported';
  }

  /**
   * Checks whether accelerated networking is required (not optional) for a VM's size.
   * @param {Object} vm - A VM model object with a `size` property.
   * @returns {boolean} True if accel net mode is 'required'.
   */
  function accelNetRequiredFor(vm) {
    return accelNetModeFor(vm) === 'required';
  }

  /**
   * Returns the accelerated networking mode for a VM's current size.
   * @param {Object} vm - A VM model object with a `size` property.
   * @returns {'required'|'optional'|'unsupported'} The accel net mode string.
   */
  function accelNetModeFor(vm) {
    const tags = sizeByName(vm.size).tags || {};
    if (tags.accelNetMode) return tags.accelNetMode;
    return tags.accelNet ? 'optional' : 'unsupported';
  }

  /**
   * Resolves the effective accelerated networking setting for a specific NIC.
   * Returns true if required by the size, false if unsupported, or the NIC's
   * own `accelerated` preference when the mode is optional.
   * @param {Object} vm - The parent VM model.
   * @param {Object} nic - The NIC object with an `accelerated` property.
   * @returns {boolean} The resolved accelerated networking state.
   */
  function resolvedAccelForNic(vm, nic) {
    const mode = accelNetModeFor(vm);
    if (mode === 'required') return true;
    if (mode === 'unsupported') return false;
    return !!nic.accelerated;
  }

  /**
   * Returns the maximum number of NICs allowed by a VM's current size.
   * Falls back to 2 if not specified.
   * @param {Object} vm - A VM model object with a `size` property.
   * @returns {number} The maximum NIC count.
   */
  function maxNicsFor(vm) {
    const tags = sizeByName(vm.size).tags || {};
    return Number(tags.maxNics || 2);
  }

  /**
   * Returns the maximum number of data disks allowed by a VM's current size.
   * Falls back to 4 if not specified.
   * @param {Object} vm - A VM model object with a `size` property.
   * @returns {number} The maximum data disk count.
   */
  function maxDataDisksFor(vm) {
    const tags = sizeByName(vm.size).tags || {};
    return Number(tags.maxDataDisks || 4);
  }

  /**
   * Returns whether the VM's current size supports Azure shared data disks.
   * NOTE: Catalog value is maintained manually because Azure CLI capability data
   * can be incomplete for SharedDiskSupported.
   * @param {Object} vm - A VM model object with a `size` property.
   * @returns {boolean} True when shared disk toggle should be available.
   */
  function sharedDiskSupportedFor(vm) {
    const tags = sizeByName(vm.size).tags || {};
    return !!tags.sharedDiskSupported;
  }

  /**
   * Creates a readable shared-disk identifier for UI and ARM naming.
   * @returns {string} New identifier like `shared-abc12345`.
   */
  function createSharedDiskId() {
    return `shared-${String(uid()).slice(0, 8).toLowerCase()}`;
  }

  /**
   * Converts a shared disk id into a safe ARM disk resource name.
   * @param {string} sharedDiskId - Logical shared disk id.
   * @returns {string} ARM-safe disk name.
   */
  function sharedDiskArmName(sharedDiskId) {
    const raw = String(sharedDiskId || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    return (raw || `shared-${String(uid()).slice(0, 8).toLowerCase()}`).slice(0, 63);
  }

  /**
   * Builds a map of shared disk ids to their references across all VMs.
   * @returns {Map<string, {id:string, sku:string, sizeGB:number, refs:Array<{vm:Object, vmIdx:number, disk:Object, diskIdx:number}>}>}
   */
  function collectSharedDiskCatalog() {
    const catalog = new Map();
    vms.forEach((vm, vmIdx) => {
      (vm.disks || []).forEach((disk, diskIdx) => {
        if (!disk || !disk.sharedEnabled) return;
        const id = String(disk.sharedDiskId || '').trim();
        if (!id) return;
        if (!catalog.has(id)) {
          catalog.set(id, {
            id,
            sku: String(disk.sku || ''),
            sizeGB: Number(disk.sizeGB || LIMITS.DEFAULT_DATA_DISK_GB),
            refs: []
          });
        }
        catalog.get(id).refs.push({ vm, vmIdx, disk, diskIdx });
      });
    });
    return catalog;
  }

  /**
   * Normalizes shared-disk settings globally (cross-VM):
   * - shared toggle is allowed only on sizes with sharedDiskSupported=true
   * - shared disk ids must be present when enabled
   * - each shared disk can be attached to at most 2 VMs
   * - secondary attachments inherit SKU/size from the primary attachment
   */
  function normalizeSharedDisksGlobal() {
    vms.forEach(vm => {
      const vmSupportsShared = sharedDiskSupportedFor(vm);
      (vm.disks || []).forEach(d => {
        d.sharedEnabled = !!d.sharedEnabled;
        d.sharedDiskId = String(d.sharedDiskId || '').trim();
        if (!vmSupportsShared || !d.sharedEnabled) {
          d.sharedEnabled = false;
          d.sharedDiskId = '';
          return;
        }
        if (!d.sharedDiskId) {
          d.sharedEnabled = false;
          d.sharedDiskId = '';
        }
      });
    });

    // Cross-VM pass: enforce max 2 attachments and sync properties.
    const catalog = collectSharedDiskCatalog();
    catalog.forEach(entry => {
      // Evict any attachments beyond the 2-VM limit (maxShares=2).
      // Excess refs are reverted to normal (non-shared) disks.
      entry.refs.slice(2).forEach(ref => {
        ref.disk.sharedEnabled = false;
        ref.disk.sharedDiskId = '';
      });

      // The first attachment is the "primary" — it defines the canonical SKU and size.
      // The second attachment (if present) inherits those properties so both VMs
      // reference the same physical managed disk characteristics.
      const primary = entry.refs[0];
      if (!primary || !primary.disk) return;
      const baseSku = String(primary.disk.sku || 'StandardSSD_LRS');
      const baseSize = Number(primary.disk.sizeGB || LIMITS.DEFAULT_DATA_DISK_GB);
      entry.refs.slice(1, 2).forEach(ref => {
        ref.disk.sku = baseSku;
        ref.disk.sizeGB = baseSize;
      });
    });
  }

  /**
   * Returns a validation error for shared disk settings on a single disk.
   * @param {Object} vm - Parent VM.
   * @param {Object} disk - Disk model.
   * @returns {string} Error message or empty string.
   */
  function sharedDiskError(vm, disk) {
    if (!disk || !disk.sharedEnabled) return '';
    if (!sharedDiskSupportedFor(vm)) return `VM size ${vm.size} does not support shared disks.`;
    if (!String(disk.sharedDiskId || '').trim()) return 'Shared disk is enabled but no shared disk id is set.';
    return '';
  }

  /**
   * Checks whether any VM has invalid shared-disk configuration.
   * @returns {boolean} True when any shared-disk validation error exists.
   */
  function hasAnySharedDiskValidationErrors() {
    const catalog = collectSharedDiskCatalog();
    for (const entry of catalog.values()) {
      // A shared disk id with >2 attachments is always invalid (maxShares=2).
      if ((entry.refs || []).length > 2) return true;
    }
    return vms.some(vm => (vm.disks || []).some(d => !!sharedDiskError(vm, d)));
  }

  /**
   * Returns attachable shared disk entries for a VM (not already attached to this VM,
   * and with capacity < 2 attachments).
   * @param {Object} vm - Target VM.
   * @returns {Array<Object>} Attachable shared disk catalog entries.
   */
  function attachableSharedDisksForVm(vm) {
    const catalog = collectSharedDiskCatalog();
    return Array.from(catalog.values()).filter((entry) => {
      const refs = entry.refs || [];
      if (!refs.length || refs.length >= 2) return false;
      return !refs.some(ref => ref.vm === vm);
    });
  }

  /**
   * Attaches the first available shared disk to the target VM as a new data disk row.
   * @param {Object} vm - Target VM.
   */
  function attachFirstSharedDiskToVm(vm) {
    if (!vm || !sharedDiskSupportedFor(vm)) return;
    const attachable = attachableSharedDisksForVm(vm);
    const entry = attachable[0];
    if (!entry) return;

    vm.disks = vm.disks || [];
    if ((vm.disks || []).length >= maxDataDisksFor(vm)) {
      showToast('Data disk limit reached', `VM size '${vm.size}' supports up to ${maxDataDisksFor(vm)} data disk(s).`);
      return;
    }

    vm.disks.push({
      sizeGB: Number(entry.sizeGB || LIMITS.DEFAULT_DATA_DISK_GB),
      sku: String(entry.sku || defaultDiskSkuFor(vm)),
      sharedEnabled: true,
      sharedDiskId: String(entry.id || '')
    });
  }

  /**
   * Converts all shared disks on a VM into normal disks by clearing shared flags.
   * Keeps disk SKU/size unchanged.
   * @param {Object} vm - VM whose disks should be converted.
   * @returns {number} Count of converted disks.
   */
  function convertSharedDisksToNormalOnVm(vm) {
    if (!vm) return 0;
    let converted = 0;
    (vm.disks || []).forEach((d) => {
      if (!d || !d.sharedEnabled) return;
      d.sharedEnabled = false;
      d.sharedDiskId = '';
      converted += 1;
    });
    return converted;
  }

  /**
   * Synchronizes SKU/size across all attachments of the same shared disk id.
   * This allows editing from either the source or secondary VM disk row.
   * @param {string} sharedDiskId - Shared disk logical id.
   * @param {Object} sourceDisk - Disk carrying latest SKU/size values.
   */
  function syncSharedDiskProperties(sharedDiskId, sourceDisk) {
    const id = String(sharedDiskId || '').trim();
    if (!id || !sourceDisk) return;
    const catalog = collectSharedDiskCatalog();
    const entry = catalog.get(id);
    if (!entry) return;
    const nextSku = String(sourceDisk.sku || 'StandardSSD_LRS');
    const nextSize = Number(sourceDisk.sizeGB || LIMITS.DEFAULT_DATA_DISK_GB);
    (entry.refs || []).slice(0, 2).forEach(ref => {
      if (!ref || !ref.disk) return;
      ref.disk.sku = nextSku;
      ref.disk.sizeGB = nextSize;
    });
  }

  /**
   * Returns an error message if a VM's NIC count exceeds its size's maxNics limit.
   * @param {Object} vm - The VM model object.
   * @returns {string} An error message, or '' if within limits.
   */
  function nicAttachmentCountError(vm) {
    const max = maxNicsFor(vm);
    const count = (vm.nics || []).length;
    if (count > max) return `VM size ${vm.size} supports up to ${max} NIC(s). Current: ${count}.`;
    return '';
  }

  /**
   * Returns an error message if a VM's data disk count exceeds its size's maxDataDisks limit.
   * @param {Object} vm - The VM model object.
   * @returns {string} An error message, or '' if within limits.
   */
  function diskAttachmentCountError(vm) {
    const max = maxDataDisksFor(vm);
    const count = (vm.disks || []).length;
    if (count > max) return `VM size ${vm.size} supports up to ${max} data disk(s). Current: ${count}.`;
    return '';
  }

  /**
   * Checks whether any VM exceeds its NIC or data disk attachment limit.
   * Used by {@link updateOutput} to gate ARM output generation.
   * @returns {boolean} True if at least one VM exceeds a size attachment limit.
   */
  function hasAnyAttachmentLimitErrors() {
    return vms.some(vm => !!nicAttachmentCountError(vm) || !!diskAttachmentCountError(vm));
  }

  /**
   * Returns a map of disk SKU names to boolean support flags for a VM's current size.
   * Missing flags are filled with sensible defaults (Standard/StandardSSD/Premium = true,
   * PremiumV2/Ultra = false).
   * @param {Object} vm - A VM model object with a `size` property.
   * @returns {Object<string, boolean>} Disk SKU support flags.
   */
  function diskSupportFlagsFor(vm) {
    const tags = sizeByName(vm.size).tags || {};
    const flags = tags.diskSkuSupport || {};
    const fallback = {
      Standard_LRS: true,
      StandardSSD_LRS: true,
      Premium_LRS: true,
      PremiumV2_LRS: false,
      UltraSSD_LRS: false
    };
    return {
      Standard_LRS: flags.Standard_LRS !== undefined ? !!flags.Standard_LRS : fallback.Standard_LRS,
      StandardSSD_LRS: flags.StandardSSD_LRS !== undefined ? !!flags.StandardSSD_LRS : fallback.StandardSSD_LRS,
      Premium_LRS: flags.Premium_LRS !== undefined ? !!flags.Premium_LRS : fallback.Premium_LRS,
      PremiumV2_LRS: flags.PremiumV2_LRS !== undefined ? !!flags.PremiumV2_LRS : fallback.PremiumV2_LRS,
      UltraSSD_LRS: flags.UltraSSD_LRS !== undefined ? !!flags.UltraSSD_LRS : fallback.UltraSSD_LRS
    };
  }

  /**
   * Returns the list of disk SKU names supported by a VM's current size.
   * Only includes SKUs where the support flag is true.
   * @param {Object} vm - A VM model object with a `size` property.
   * @returns {string[]} Supported disk SKU names (e.g. ['Standard_LRS', 'Premium_LRS']).
   */
  function supportedDiskSkusFor(vm) {
    const flags = diskSupportFlagsFor(vm);
    return diskSkus.filter(s => !!flags[s]);
  }

  /**
   * Returns the preferred default disk SKU for a VM's current size.
   * Prefers 'StandardSSD_LRS' if supported; otherwise uses the first supported SKU.
   * @param {Object} vm - A VM model object with a `size` property.
   * @returns {string} The default disk SKU name.
   */
  function defaultDiskSkuFor(vm) {
    const supported = supportedDiskSkusFor(vm);
    if (supported.includes('StandardSSD_LRS')) return 'StandardSSD_LRS';
    return supported[0] || 'Standard_LRS';
  }

  /**
   * Coerces unsupported data disk SKUs to the default for the VM's current size.
   * Called after a VM size change to fix any disks whose SKU is no longer valid.
   * @param {Object} vm - A VM model object whose disks will be mutated.
   * @returns {number} The number of disks that were changed.
   */
  function normalizeDataDiskSkus(vm) {
    const supported = supportedDiskSkusFor(vm);
    const fallback = defaultDiskSkuFor(vm);
    let changed = 0;
    (vm.disks || []).forEach(d => {
      if (!supported.includes(d.sku)) {
        d.sku = fallback;
        changed += 1;
      }
    });
    return changed;
  }

  /**
   * Returns OS images compatible with a VM's current size, generation, and disk controller.
   * Results are cached per render cycle in `state._imageCache` for performance.
   * Filters by: generation, architecture, disk controller capability, and optionally publisher.
   * @param {Object} vm - The VM model with size/gen/diskControllerType/publisherFilter.
   * @param {boolean} includePublisherFilter - When true, also filters by vm.publisherFilter.
   * @returns {Array<Object>} Array of matching imageOptions entries.
   */
  function filteredImages(vm, includePublisherFilter) {
    // Per-cycle cache: key = size|gen|controller|publisherFilter|includePublisher
    if (!state._imageCache) state._imageCache = new Map();
    const cacheKey = `${vm.size}|${vm.gen}|${vm.diskControllerType}|${includePublisherFilter ? vm.publisherFilter || '' : ''}|${!!includePublisherFilter}`;
    if (state._imageCache.has(cacheKey)) return state._imageCache.get(cacheKey);

    let candidates = imageOptions.filter(img => img.gen === vm.gen);
    const allowedArch = allowedArchitecturesFor(vm);
    candidates = candidates.filter(img => allowedArch.includes(img.arch || 'x64'));

    const controller = vm.diskControllerType;
    if (controller === 'NVMe') candidates = candidates.filter(img => !!img.nvmeCapable);
    if (controller === 'SCSI') candidates = candidates.filter(img => !!img.scsiCapable);

    if (includePublisherFilter) {
      const publisher = String(vm.publisherFilter || '').trim();
      if (publisher) candidates = candidates.filter(img => String((img.ref && img.ref.publisher) || '') === publisher);
    }

    state._imageCache.set(cacheKey, candidates);
    return candidates;
  }

  /**
   * Returns OS images filtered by generation, architecture, controller, AND publisher.
   * This is the primary filter used by image dropdowns and sanitization.
   * Shorthand for `filteredImages(vm, true)`.
   * @param {Object} vm - The VM model object.
   * @returns {Array<Object>} Array of matching imageOptions entries.
   */
  function filterImagesFor(vm) {
    // Filter by generation + architecture + controller + optional publisher.
    return filteredImages(vm, true);
  }

/**
 * Returns OS images filtered by generation, architecture, and controller only
 * (excludes publisher filter). Used to populate the publisher dropdown so all
 * compatible publishers are shown regardless of the current publisher selection.
 * Shorthand for `filteredImages(vm, false)`.
 * @param {Object} vm - The VM model object.
 * @returns {Array<Object>} Array of matching imageOptions entries.
 */
function baseFilteredImagesFor(vm) {
  // Same as above but without publisher filter (used to populate publisher list).
  return filteredImages(vm, false);
}

/**
 * Returns a sorted list of unique publisher names from images compatible with the VM.
 * Uses {@link baseFilteredImagesFor} (no publisher filter) to enumerate all publishers.
 * @param {Object} vm - The VM model object.
 * @returns {string[]} Sorted array of publisher names (e.g. ['Canonical', 'Debian', 'RedHat']).
 */
function publishersFor(vm) {
  const pubs = new Set(baseFilteredImagesFor(vm).map(i => (i.ref && i.ref.publisher) || '').filter(Boolean));
  return Array.from(pubs).sort((a, b) => String(a).localeCompare(String(b)));
}
state.vms = [
  {
    id: uid(),
    name: 'vm1',
    size: 'Standard_D4s_v5',
    gen: 'Gen2',
    imageKey: 'ubuntu_24_04_lts_server_x64_gen2',
    diskControllerType: 'SCSI',
    customData: '',
    rebootRequired: false,
    nics: [ defaultNic(0) ],
    disks: []
  }
];

/**
 * Restores saved UI state from localStorage.
 * Loads VMs, size filters, storage options, extra-options open state, and active tab index.
 * Silently falls back to defaults if localStorage is unavailable or data is corrupted.
 * Called once at startup before the first render.
 */
function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;

    if (Array.isArray(parsed.vms) && parsed.vms.length) {
      state.vms = parsed.vms;
    }
    if (parsed.sizeFilters && typeof parsed.sizeFilters === 'object') {
      Object.assign(state.sizeFilters, parsed.sizeFilters);
    }
    if (parsed.storageOptions && typeof parsed.storageOptions === 'object') {
      state.storageOptions = normalizeStorageOptions(parsed.storageOptions);
    }
    if (typeof parsed.extraOptionsOpen === 'boolean') {
      state.extraOptionsOpen = parsed.extraOptionsOpen;
    }
    if (Array.isArray(parsed.customNsgRules)) {
      state.customNsgRules = parsed.customNsgRules;
    }
    if (Number.isInteger(parsed.activeVmIndex) && parsed.activeVmIndex >= 0) {
      state.activeVmIndex = parsed.activeVmIndex;
    }
  } catch (err) {
    console.warn('Failed to load saved UI state:', err);
  }
}

/**
 * Persists current UI state to localStorage.
 * Saves VMs, size filters, storage options, extra-options open state, and active tab index
 * under the key defined by {@link UI_STATE_STORAGE_KEY}.
 * Called from {@link updateOutput} after every user change.
 */
function saveUiState() {
  try {
    const payload = {
      vms: state.vms,
      sizeFilters: state.sizeFilters,
      storageOptions: state.storageOptions,
      extraOptionsOpen: state.extraOptionsOpen,
      customNsgRules: state.customNsgRules,
      activeVmIndex: state.activeVmIndex
    };
    localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('Failed to save UI state:', err);
  }
}

Object.defineProperties(globalThis, {
  vms: {
    get() { return state.vms; },
    set(value) { state.vms = value; },
    configurable: true
  },
  active: {
    get() { return state.activeVmIndex; },
    set(value) { state.activeVmIndex = value; },
    configurable: true
  },
  sizeFilters: {
    get() { return state.sizeFilters; },
    configurable: true
  }
});

loadUiState();

  // -----------------------------
  // UI rendering and interaction
  // -----------------------------
  const el = (id) => document.getElementById(id);
  /** @deprecated Alias kept for brevity — prefer el() for clarity. */
  const $ = el;

  /**
   * Ensures a VM has at least one NIC. If the NIC array is empty or missing,
   * creates a default primary NIC. Called defensively before rendering NICs.
   * @param {Object} vm - The VM model object (mutated in place).
   */
  function ensureNic(vm) {
    if (!vm.nics || vm.nics.length === 0) vm.nics = [ defaultNic(0) ];
  }

  /**
   * Renders the VM tab bar. Creates a button for each VM, highlighting the active tab.
   * Supports keyboard navigation (ArrowLeft/Right/Home/End) and ARIA tablist semantics.
   * Also updates the Remove VM button's disabled state.
   */
  function renderTabs() {
    const tabsEl = $('tabs');
    tabsEl.innerHTML = '';
    vms.forEach((vm, idx) => {
      const b = document.createElement('button');
      b.className = 'tab' + (idx === active ? ' active' : '');
      b.textContent = vm.name || `vm${idx+1}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(idx === active));
      b.tabIndex = idx === active ? 0 : -1;
      b.onclick = () => { active = idx; render(); };
      b.onkeydown = (e) => {
        let next = -1;
        if (e.key === 'ArrowRight') next = (idx + 1) % vms.length;
        else if (e.key === 'ArrowLeft') next = (idx - 1 + vms.length) % vms.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = vms.length - 1;
        if (next < 0) return;
        e.preventDefault();
        active = next;
        render();
        const nextBtn = tabsEl.children[next];
        if (nextBtn) nextBtn.focus();
      };
      tabsEl.appendChild(b);
    });
    $('removeVmBtn').disabled = vms.length <= 1;
  }

  /**
   * Replaces all options in a `<select>` element with new values.
   * @param {HTMLSelectElement} selectEl - The select element to populate.
   * @param {string[]} values - Array of option values.
   * @param {Object<string, string>} [labelsByValue] - Optional map of value → display label.
   */
  function setSelectOptions(selectEl, values, labelsByValue) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    values.forEach(v => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = (labelsByValue && labelsByValue[v]) ? labelsByValue[v] : v;
      selectEl.appendChild(o);
    });
  }

  /**
   * Renders the filter dimension dropdowns inside the size filter panel dialog.
   * One dropdown per filter dimension (family, arch, gen, controller, etc.).
   * Pre-selects the current filter values from `state.sizeFilters`.
   */
  function renderSizeFilterPanelFields() {
    const grid = $('sizeFilterGrid');
    if (!grid) return;
    grid.innerHTML = '';

    Object.keys(sizeFilterMeta).forEach((key) => {
      const meta = sizeFilterMeta[key];
      const item = document.createElement('div');
      item.className = 'size-filter-item';

      const label = document.createElement('label');
      label.textContent = meta.label;

      const sel = document.createElement('select');
      sel.setAttribute('data-filter-key', key);

      const labels = { '': 'Any' };
      (meta.values || []).forEach(v => {
        labels[v] = (meta.valueLabels && meta.valueLabels[v]) ? meta.valueLabels[v] : v;
      });
      setSelectOptions(sel, [''].concat(meta.values || []), labels);
      sel.value = sizeFilters[key] || '';

      item.appendChild(label);
      item.appendChild(sel);
      grid.appendChild(item);
    });
  }

  /**
   * Renders active size filter values as removable chip buttons.
   * Shows "No active filters" if none are set. Also triggers a screen-reader
   * announcement of the matching size count via the aria-live region.
   */
  function renderSizeFilterChips() {
    const chips = $('sizeFilterChips');
    if (!chips) return;
    chips.innerHTML = '';

    const activeFilterKeys = Object.keys(sizeFilterMeta).filter(k => !!sizeFilters[k]);
    activeFilterKeys.forEach(k => {
      const meta = sizeFilterMeta[k];
      const raw = sizeFilters[k];
      const shown = (meta.valueLabels && meta.valueLabels[raw]) ? meta.valueLabels[raw] : raw;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn';
      chip.setAttribute('data-filter-key', k);
      chip.innerHTML = `${meta.label}: ${shown} <span class="x">×</span>`;
      chips.appendChild(chip);
    });

    if (!activeFilterKeys.length) {
      const muted = document.createElement('span');
      muted.className = 'muted';
      muted.style.marginTop = '0';
      muted.textContent = 'No active filters';
      chips.appendChild(muted);
    }

    renderSizeFilterPanelFields();

    // Announce filter result count to screen readers
    const liveEl = $('sizeFilterLive');
    if (liveEl) {
      const count = filteredSizeOptions().length;
      const total = sizeOptions.length;
      liveEl.textContent = activeFilterKeys.length
        ? `${count} of ${total} VM size${count !== 1 ? 's' : ''} match${count === 1 ? 'es' : ''} current filters.`
        : '';
    }
  }

  /**
   * Switches the VM's size to the first matching filtered size if the current
   * size is no longer in the filtered set. Prevents an invalid size from
   * remaining selected after filter changes.
   * @param {Object} vm - The VM model object (mutated in place).
   */
  function alignVmSizeToActiveFilters(vm) {
    const filtered = filteredSizeOptions();
    if (!vm || !filtered.length) return;
    if (!filtered.some(s => s.name === vm.size)) {
      vm.size = filtered[0].name;
    }
  }

  /**
   * Populates the VM Size dropdown with sizes that match the current filters.
   * Shows "No VM sizes match filters" and disables the select if the list is empty.
   * @param {Object} vm - The active VM model (used to set the selected value).
   */
  function populateSizeSelect(vm) {
    const sel = $('vmSize');
    sel.innerHTML = '';
    const list = filteredSizeOptions();

    list.forEach(s => {
      const o = document.createElement('option');
      o.value = s.name;
      o.textContent = s.name;
      sel.appendChild(o);
    });

    if (!list.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No VM sizes match filters';
      sel.appendChild(o);
      sel.value = '';
      sel.disabled = true;
      return;
    }

    sel.disabled = false;
    if (vm && list.some(s => s.name === vm.size)) {
      sel.value = vm.size;
    }
  }

  /**
   * Populates the VM Generation dropdown with generations allowed by the current size.
   * Auto-corrects `vm.gen` if the current value is no longer valid.
   * Disables the dropdown when only one generation is available.
   * @param {Object} vm - The VM model object (may be mutated).
   */
  function populateGenSelect(vm) {
    const sel = $('vmGen');
    sel.innerHTML = '';
    const allowed = allowedGenerationsFor(vm);
    allowed.forEach(g => {
      const o = document.createElement('option');
      o.value = g;
      o.textContent = g;
      sel.appendChild(o);
    });
    if (!allowed.includes(vm.gen)) vm.gen = allowed[0];
    sel.value = vm.gen;
    sel.disabled = allowed.length <= 1;
  }

  /**
   * Populates the Disk Controller dropdown with controllers allowed by the current
   * size and generation. Auto-corrects `vm.diskControllerType` if invalid.
   * Disables the dropdown when only one controller is available.
   * @param {Object} vm - The VM model object (may be mutated).
   */
  function populateControllerSelect(vm) {
    const sel = $('diskController');
    sel.innerHTML = '';
    const allowed = allowedControllersFor(vm);
    allowed.forEach(c => {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      sel.appendChild(o);
    });
    if (!allowed.includes(vm.diskControllerType)) vm.diskControllerType = allowed[0];
    sel.value = vm.diskControllerType;
    sel.disabled = allowed.length <= 1;
  }

  /**
   * Populates the Publisher dropdown with publishers available for the current
   * VM's compatibility constraints. Includes an "All publishers" option.
   * Clears `vm.publisherFilter` if the previously selected publisher is no longer available.
   * @param {Object} vm - The VM model object (may be mutated).
   */
  function populatePublisherSelect(vm) {
    const sel = $('vmPublisher');
    if (!sel) return;
    sel.innerHTML = '';
    const pubs = publishersFor(vm);

    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All publishers';
    sel.appendChild(all);

    pubs.forEach(p => {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p;
      sel.appendChild(o);
    });

    if (vm.publisherFilter && !pubs.includes(vm.publisherFilter)) vm.publisherFilter = '';
    sel.value = vm.publisherFilter || '';
  }

  /**
   * Populates the OS Image dropdown with images compatible with the VM's current
   * size, generation, controller, and optional publisher filter.
   * Auto-corrects `vm.imageKey` if the current image is no longer in the list.
   * @param {Object} vm - The VM model object (may be mutated).
   */
  function populateImageSelect(vm) {
    const sel = $('vmImage');
    sel.innerHTML = '';
    const imgs = filterImagesFor(vm);
    imgs.forEach(img => {
      const o = document.createElement('option');
      o.value = img.key;
      o.textContent = img.label;
      sel.appendChild(o);
    });
    if (!imgs.find(i => i.key === vm.imageKey)) vm.imageKey = imgs[0] ? imgs[0].key : '';
    sel.value = vm.imageKey;
  }

  /**
   * Updates the hint text below the VM Size and OS Image selects.
   * Shows accelerated networking mode, NIC/disk limits, filter mismatch warnings,
   * and NVMe-only notices based on the VM's current size and filters.
   * @param {Object} vm - The active VM model object.
   */
  function renderHints(vm) {
    const hintEl = $('sizeHint');
    const sz = sizeByName(vm.size);
    const accelMode = accelNetModeFor(vm);
    const accelText = accelMode === 'required' ? 'Required' : (accelMode === 'unsupported' ? 'Not supported' : 'Supported (optional)');
    const hasMatchingSizes = filteredSizeOptions().length > 0;
    const currentSizeMatches = !sizeIsOutsideFilters(vm.size);

    if (!hasMatchingSizes) {
      if (hintEl) {
        hintEl.style.display = '';
        hintEl.textContent = 'No VM size matches the filters.';
      }
    } else if (!currentSizeMatches) {
      if (hintEl) {
        hintEl.textContent = '';
        hintEl.style.display = 'none';
      }
    } else if (hintEl) {
      hintEl.style.display = '';
      hintEl.textContent = `Supports: Arch ${allowedArchitecturesFor(vm).join('/')} | ${sz.tags.generations.join(', ')} | DiskCtl (for ${vm.gen}): ${allowedControllersFor(vm).join(', ')} | AccelNet: ${accelText} | Max NICs: ${maxNicsFor(vm)} | Max Data Disks: ${maxDataDisksFor(vm)}`;
    }

    const imgs = filterImagesFor(vm);
    const notes = [];
    const allowedCtl = allowedControllersFor(vm);
  if (allowedCtl.length === 1 && allowedCtl[0] === 'NVMe') {
      notes.push('NVMe-only size: images must be NVMe-tagged (verify with az vm image show).');
    }
    $('imageHint').textContent = imgs.length ? notes.join(' ') : 'No images match this size. Add more image mappings or relax filters.';
  }

  /**
   * Renders the VM Configuration Summary table below the ARM JSON output.
   * Displays one row per VM with name, size, image, controller, NIC count, and disk count.
   * Shows "No VMs defined" if the VM list is empty.
   */
  function renderVmSummaryTable() {
    const host = $('vmSummary');
    if (!host) return;

    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const td = (v) => {
      const t = String(v ?? '-');
      return `<td><span class="truncate-cell" title="${esc(t)}">${esc(t)}</span></td>`;
    };

    if (!vms.length) {
      host.innerHTML = '<div class="muted">No VMs defined.</div>';
      return;
    }

    const rows = vms.map(vm => {
      const img = imageByKey(vm.imageKey);
      const nicCount = (vm.nics || []).length;
      const publicIps = (vm.nics || []).filter(n => !!n.publicIp).length;
      const diskCount = (vm.disks || []).length;
      return `<tr>
        ${td(vm.name)}
        ${td(vm.size)}
        ${td(img ? img.label : '-')}
        ${td(vm.diskControllerType || '-')}
        ${td(`${nicCount} (Public IPs: ${publicIps})`)}
        ${td(String(diskCount))}
      </tr>`;
    }).join('');

    host.innerHTML = `<table class="summary">
      <thead>
        <tr>
          <th>VM Name</th>
          <th>VM Size</th>
          <th>Image</th>
          <th>Disk Controller</th>
          <th>NICs</th>
          <th>Data Disks</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  /**
   * Renders the Storage Configuration Summary section below the VM summary.
   * Only visible when at least one storage protocol (SMB/NFS) is enabled.
   * Shows protocol-specific cards with the configured share name.
   */
  function renderStorageSummary() {
    const section = $('storageSummarySection');
    const host = $('storageSummary');
    if (!section || !host) return;

    const cfg = normalizeStorageOptions(state.storageOptions);
    const smbOn = !!cfg.smbEnabled;
    const nfsOn = !!cfg.nfsEnabled;
    const hasAnyProtocolEnabled = smbOn || nfsOn;

    // Show summary only when storage is enabled and at least one protocol is selected.
    section.style.display = hasAnyProtocolEnabled ? '' : 'none';
    if (!hasAnyProtocolEnabled) {
      host.innerHTML = '';
      return;
    }

    const smbBlock = smbOn
      ? `<div class="box" style="margin-top: 0;">
          <div class="row" style="margin-bottom: 6px;"><strong>SMB</strong><span class="pill ok">Enabled</span></div>
          <table class="summary"><tbody>
            <tr><td>Share parameter</td><td>${cfg.smbShareName}</td></tr>
          </tbody></table>
        </div>`
      : '';

    const nfsBlock = nfsOn
      ? `<div class="box" style="margin-top: 0;">
          <div class="row" style="margin-bottom: 6px;"><strong>NFS</strong><span class="pill ok">Enabled</span></div>
          <table class="summary"><tbody>
            <tr><td>Share parameter</td><td>${cfg.nfsShareName}</td></tr>
          </tbody></table>
        </div>`
      : '';
    host.innerHTML = `<div style="display:grid;grid-template-columns:1fr;gap:8px;">${smbBlock}${nfsBlock}</div>`;
  }

  /**
   * Renders the NIC list for the active VM. Creates a card for each NIC with:
   * name input, accelerated networking toggle (respects size policy), public IP toggle,
   * and a remove button. Also shows NIC attachment limit errors if exceeded.
   * @param {Object} vm - The VM model whose NICs are rendered.
   */
  function renderNics(vm) {
    ensureNic(vm);
    const list = $('nicList');
    list.innerHTML = '';
    const nics = vm.nics || [];
    $('noNicMsg').style.display = nics.length ? 'none' : 'block';
    const nicLimitErr = nicAttachmentCountError(vm);

    const allowAccel = accelNetSupportedFor(vm);
    const requireAccel = accelNetRequiredFor(vm);

    nics.forEach((nic, idx) => {
      const box = document.createElement('div');
      box.className = 'box';

      const header = document.createElement('div');
      header.className = 'row';
      const headerLeft = document.createElement('div');
      const headerStrong = document.createElement('strong');
      headerStrong.textContent = String(nic.name || '');
      const headerMuted = document.createElement('span');
      headerMuted.className = 'muted';
      headerMuted.textContent = idx === 0 ? '(primary)' : '';
      headerLeft.appendChild(headerStrong);
      headerLeft.appendChild(document.createTextNode(' '));
      headerLeft.appendChild(headerMuted);
      header.appendChild(headerLeft);

      const rm = document.createElement('button');
      rm.className = 'danger';
      rm.textContent = 'Remove NIC';
      rm.disabled = nics.length <= 1;
      rm.onclick = () => { vm.nics.splice(idx, 1); renderNics(vm); updateNicDiskButtons(vm); updateOutput(); };
      header.appendChild(rm);

      const grid = document.createElement('div');
      grid.className = 'grid3';

      const nameWrap = document.createElement('div');
      const nicErrText = nicNameError(vm, nic);
      const nicMaxLen = nicNameMaxLengthForVmName(vm.name);
      const nameLabel = document.createElement('label');
      nameLabel.textContent = 'NIC Name';
      const nameInput = document.createElement('input');
      nameInput.value = String(nic.name || '');
      nameInput.maxLength = nicMaxLen;
      nameWrap.appendChild(nameLabel);
      nameWrap.appendChild(nameInput);
      nameInput.oninput = (e) => {
        nic.name = (e.target.value || '').trim() || nextDefaultNicName(vm);

        const errText = nicNameError(vm, nic);
        const errEl = box.querySelector('.nic-line-error');
        if (errEl) {
          errEl.textContent = errText;
          errEl.style.display = errText ? 'block' : 'none';
        }
        const fixEl = box.querySelector('.nic-line-fix');
        if (fixEl) fixEl.style.display = errText ? 'block' : 'none';

        renderTabs();
        updateOutput();
      };

      const accWrap = document.createElement('div');
      if (!allowAccel) {
        nic.accelerated = false;
        accWrap.innerHTML = `<label>Accelerated Networking</label>
          <div class="muted">Not supported for this VM size.</div>`;
      } else {
        if (requireAccel) nic.accelerated = true;
        accWrap.innerHTML = `<label>Accelerated Networking</label>
          <div class="toggle"><input type="checkbox" ${resolvedAccelForNic(vm, nic) ? 'checked' : ''} ${requireAccel ? 'disabled' : ''} /> <span class="muted">${requireAccel ? 'Required by selected VM size' : 'enableAcceleratedNetworking'}</span></div>`;
        const accCb = accWrap.querySelector('input');
        if (accCb) accCb.onchange = (e) => { nic.accelerated = requireAccel ? true : !!e.target.checked; updateOutput(); };
      }

      const pipWrap = document.createElement('div');
      pipWrap.innerHTML = `<label>Public IP</label>
        <div class="toggle"><input type="checkbox" ${nic.publicIp ? 'checked' : ''} /> <span class="muted">create Public IP + DNS</span></div>`;
      pipWrap.querySelector('input').onchange = (e) => { nic.publicIp = !!e.target.checked; updateOutput(); };

      grid.appendChild(nameWrap);
      grid.appendChild(accWrap);
      grid.appendChild(pipWrap);

      box.appendChild(header);
      box.appendChild(grid);
      const lineError = document.createElement('div');
      lineError.className = 'error-text nic-line-error';
      lineError.textContent = nicErrText;
      lineError.style.display = nicErrText ? 'block' : 'none';
      box.appendChild(lineError);
      const lineFix = document.createElement('div');
      lineFix.className = 'error-text nic-line-fix';
      lineFix.textContent = 'Fix NIC name errors before generating the ARM template.';
      lineFix.style.display = nicErrText ? 'block' : 'none';
      box.appendChild(lineFix);
      list.appendChild(box);
    });

    if (nicLimitErr) {
      const limitErr = document.createElement('div');
      limitErr.className = 'error-text';
      limitErr.textContent = nicLimitErr;
      list.appendChild(limitErr);
    }
  }

  /**
   * Renders the data disk list for the active VM. Creates a card for each disk with:
   * size input, SKU dropdown (filtered to supported SKUs), and a remove button.
   * Also shows disk attachment limit errors if exceeded.
   * @param {Object} vm - The VM model whose data disks are rendered.
   */
  function renderDisks(vm) {
    const diskList = $('diskList');
    diskList.innerHTML = '';
    const disks = vm.disks || [];
    const supportedSkus = supportedDiskSkusFor(vm);

    // ── Shared disk UI state ─────────────────────────────────────────────
    // vmSupportsShared: whether the VM size's catalog entry has sharedDiskSupported=true.
    // sharedCatalog: cross-VM map of all shared disk IDs → { refs, sku, sizeGB }.
    // attachableShared: shared disks from other VMs that this VM can still attach to
    //                   (i.e., disks with <2 attachments and not already on this VM).
    const vmSupportsShared = sharedDiskSupportedFor(vm);
    const noDiskMsg = $('noDiskMsg');
    const diskLimitErr = diskAttachmentCountError(vm);
    const sharedCatalog = collectSharedDiskCatalog();
    const attachableShared = attachableSharedDisksForVm(vm);

    // ── "Attach shared disk (N)" button ──────────────────────────────────
    // Dynamically created once and inserted before the "Add disk" button.
    // Shown only when the VM size supports shared disks AND there are
    // available shared disks from other VMs to attach to. Clicking it
    // adds a new disk row pre-configured as a secondary attachment to the
    // first available shared disk.
    const addDiskBtn = $('addDiskBtn');
    if (addDiskBtn) {
      let attachBtn = $('attachSharedDiskBtn');
      if (!attachBtn) {
        attachBtn = document.createElement('button');
        attachBtn.id = 'attachSharedDiskBtn';
        attachBtn.type = 'button';
        attachBtn.style.marginRight = '8px';
        addDiskBtn.parentElement && addDiskBtn.parentElement.insertBefore(attachBtn, addDiskBtn);
      }
      const showAttachBtn = vmSupportsShared && attachableShared.length > 0;
      attachBtn.style.display = showAttachBtn ? '' : 'none';
      attachBtn.textContent = `Attach shared disk (${attachableShared.length})`;
      attachBtn.disabled = (vm.disks || []).length >= maxDataDisksFor(vm);
      attachBtn.onclick = () => {
        attachFirstSharedDiskToVm(vm);
        renderDisks(vm);
        updateNicDiskButtons(vm);
        updateOutput();
      };
    }

    // Context-aware "no disks" message:
    //   1. If shared disks exist elsewhere but this VM size doesn't support them → explain.
    //   2. If shared disks exist and this VM size supports them → guide user to attach.
    //   3. Otherwise → plain "No data disks."
    if (noDiskMsg) {
      noDiskMsg.style.display = disks.length ? 'none' : 'block';
      if (!disks.length) {
        const hasExistingShared = Array.from(sharedCatalog.values()).some(entry => (entry.refs || []).length > 0);
        if (hasExistingShared && !vmSupportsShared) {
          noDiskMsg.textContent = `No data disks. Shared disks exist in other VMs, but VM size '${vm.size}' has sharedDiskSupported=false.`;
        } else if (hasExistingShared && vmSupportsShared) {
          noDiskMsg.textContent = 'No data disks. Use "Attach shared disk" to add one, or use Add disk for a new local disk.';
        } else {
          noDiskMsg.textContent = 'No data disks.';
        }
      }
    }

    disks.forEach((d, di) => {
      const box = document.createElement('div');
      box.className = 'box';
      const diskErrText = diskSizeError(d);
      const sharedErrText = sharedDiskError(vm, d);

      const grid = document.createElement('div');
      grid.className = 'grid3';

      // Shared disk state for this disk row. Three mutually exclusive states:
      //   - Not shared: sharedEntry is null.
      //   - Primary: this disk is the first (defining) attachment — controls SKU/size.
      //   - Secondary: this disk is attached to an existing shared disk from another VM.
      const sharedEntry = d.sharedEnabled && d.sharedDiskId ? sharedCatalog.get(d.sharedDiskId) : null;
      const isSharedPrimary = !!(sharedEntry && sharedEntry.refs && sharedEntry.refs[0] && sharedEntry.refs[0].disk === d);
      const isSharedSecondary = !!(sharedEntry && sharedEntry.refs && sharedEntry.refs.length > 0 && !isSharedPrimary);

      const sizeWrap = document.createElement('div');
      sizeWrap.innerHTML = `<label>Size (GB)</label><input type="number" min="2" value="${d.sizeGB}" />`;
      const sizeInput = sizeWrap.querySelector('input');
      sizeWrap.querySelector('input').oninput = (e) => {
        d.sizeGB = Number(e.target.value || 0);
        if (d.sharedEnabled && d.sharedDiskId) {
          syncSharedDiskProperties(d.sharedDiskId, d);
        }
        const errText = diskSizeError(d);
        const errEl = box.querySelector('.disk-line-error');
        if (errEl) {
          errEl.textContent = errText;
          errEl.style.display = errText ? 'block' : 'none';
        }
        const fixEl = box.querySelector('.disk-line-fix');
        if (fixEl) fixEl.style.display = errText ? 'block' : 'none';
        updateOutput();
      };

      const skuWrap = document.createElement('div');
      const skuSel = document.createElement('select');
      supportedSkus.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; skuSel.appendChild(o); });
      if (!supportedSkus.includes(d.sku)) d.sku = defaultDiskSkuFor(vm);
      skuSel.value = d.sku;
      skuSel.onchange = (e) => {
        d.sku = e.target.value;
        if (d.sharedEnabled && d.sharedDiskId) {
          syncSharedDiskProperties(d.sharedDiskId, d);
        }
        const errText = diskSizeError(d);
        const errEl = box.querySelector('.disk-line-error');
        if (errEl) {
          errEl.textContent = errText;
          errEl.style.display = errText ? 'block' : 'none';
        }
        const fixEl = box.querySelector('.disk-line-fix');
        if (fixEl) fixEl.style.display = errText ? 'block' : 'none';
        updateOutput();
      };
      skuWrap.appendChild(document.createElement('label')).textContent = 'SKU';
      skuWrap.appendChild(skuSel);

      const rmBtn = document.createElement('button');
      rmBtn.className = 'danger';
      rmBtn.textContent = 'Remove';
      rmBtn.onclick = () => { disks.splice(di, 1); renderDisks(vm); updateNicDiskButtons(vm); updateOutput(); };

      grid.appendChild(sizeWrap);
      grid.appendChild(skuWrap);
      grid.appendChild(rmBtn);

      box.appendChild(grid);

      // ── Shared disk controls (shown only if VM size supports shared disks) ──
      // "Enable shared disk" → creates a new shared disk ID and marks the disk shared.
      // "Disable shared disk" → removes this disk row entirely. If no other VM
      //   references the shared disk ID, the shared disk resource disappears
      //   (shared disks are derived from current attachments, not stored separately).
      if (vmSupportsShared) {
        const sharedWrap = document.createElement('div');
        sharedWrap.style.marginTop = '8px';

        const sharedToggleBtn = document.createElement('button');
        sharedToggleBtn.type = 'button';
        sharedToggleBtn.textContent = d.sharedEnabled ? 'Disable shared disk' : 'Enable shared disk';
        sharedToggleBtn.onclick = () => {
          // Disable shared disk = detach it from this VM (remove this disk row).
          // If no other VM references the shared disk id, it disappears automatically
          // because shared disk resources are derived from current VM attachments.
          if (d.sharedEnabled) {
            disks.splice(di, 1);
            renderDisks(vm);
            updateNicDiskButtons(vm);
            updateOutput();
            return;
          }

          d.sharedEnabled = true;
          if (!d.sharedDiskId) d.sharedDiskId = createSharedDiskId();
          renderDisks(vm);
          updateOutput();
        };
        sharedWrap.appendChild(sharedToggleBtn);

        // Shared disk assignment dropdown. Options:
        //   1. "Create new shared disk" — generates a fresh shared disk ID.
        //   2. Current disk ID (if already shared) — shows source/attached label.
        //   3. Available shared disks from other VMs with <2 attachments.
        // Selecting an existing shared disk copies its SKU/size to this disk.
        const selectorWrap = document.createElement('div');
        selectorWrap.style.marginTop = '6px';
        selectorWrap.style.display = d.sharedEnabled ? '' : 'none';
        const selLabel = document.createElement('label');
        selLabel.textContent = 'Shared disk assignment';
        const sharedSel = document.createElement('select');

        const newOpt = document.createElement('option');
        newOpt.value = '__new__';
        newOpt.textContent = 'Create new shared disk';
        sharedSel.appendChild(newOpt);

        if (d.sharedEnabled && d.sharedDiskId) {
          const currentOpt = document.createElement('option');
          currentOpt.value = d.sharedDiskId;
          if (isSharedSecondary) {
            currentOpt.textContent = `Attached to ${d.sharedDiskId} (using shared disk)`;
          } else {
            currentOpt.textContent = `Using ${d.sharedDiskId} (source shared disk)`;
          }
          sharedSel.appendChild(currentOpt);
        }

        for (const [id, entry] of sharedCatalog.entries()) {
          if (!id || id === d.sharedDiskId) continue;
          const used = (entry.refs || []).length;
          if (used >= 2) continue;
          const o = document.createElement('option');
          o.value = id;
          o.textContent = `Attach to ${id} (${entry.sku}, ${entry.sizeGB} GB, ${used}/2 attached)`;
          sharedSel.appendChild(o);
        }

        let selectedValue = '__new__';
        if (d.sharedEnabled && d.sharedDiskId) {
          selectedValue = d.sharedDiskId;
        }
        sharedSel.value = selectedValue;

        sharedSel.onchange = (e) => {
          const selectedId = String(e.target.value || '__new__');
          if (selectedId === '__new__') {
            d.sharedEnabled = true;
            d.sharedDiskId = createSharedDiskId();
          } else {
            const target = sharedCatalog.get(selectedId);
            if (target && (target.refs || []).length < 2) {
              d.sharedEnabled = true;
              d.sharedDiskId = selectedId;
              d.sku = target.sku;
              d.sizeGB = Number(target.sizeGB || d.sizeGB);
            }
          }
          renderDisks(vm);
          updateOutput();
        };

        selectorWrap.appendChild(selLabel);
        selectorWrap.appendChild(sharedSel);
        sharedWrap.appendChild(selectorWrap);

        // Primary attachment info: shows shared disk ID, attachment count (N/2), and VM names.
        if (d.sharedEnabled && d.sharedDiskId && isSharedPrimary) {
          const sourceInfo = document.createElement('div');
          sourceInfo.className = 'muted';
          sourceInfo.style.marginTop = '6px';
          const attachedCount = sharedEntry && sharedEntry.refs ? sharedEntry.refs.length : 1;
          const vmNames = sharedEntry && sharedEntry.refs
            ? sharedEntry.refs.map(ref => String((ref.vm && ref.vm.name) || '').trim()).filter(Boolean)
            : [];
          sourceInfo.textContent = `Shared disk name: ${d.sharedDiskId} (${attachedCount}/2 attached). VMs: ${vmNames.join(', ') || vm.name}.`;
          sharedWrap.appendChild(sourceInfo);
        }

        // Secondary attachment info: shows which shared disk this is attached to,
        // the VM names sharing it, and a note that SKU/size edits sync to both VMs.
        if (isSharedSecondary && sharedEntry) {
          const inherited = document.createElement('div');
          inherited.className = 'muted';
          inherited.style.marginTop = '6px';
          const vmNames = sharedEntry.refs
            ? sharedEntry.refs.map(ref => String((ref.vm && ref.vm.name) || '').trim()).filter(Boolean)
            : [];
          inherited.textContent = `Attached to ${sharedEntry.id}. VMs: ${vmNames.join(', ') || vm.name}. Changes to SKU/size are synchronized across both VMs.`;
          sharedWrap.appendChild(inherited);
        }

        box.appendChild(sharedWrap);
      }

      const lineError = document.createElement('div');
      lineError.className = 'error-text disk-line-error';
      lineError.textContent = diskErrText;
      lineError.style.display = diskErrText ? 'block' : 'none';
      box.appendChild(lineError);

      // Shared disk errors are shown separately from disk size/SKU errors
      // because they represent cross-VM configuration issues (e.g., unsupported size).
      const sharedLineError = document.createElement('div');
      sharedLineError.className = 'error-text disk-shared-line-error';
      sharedLineError.textContent = sharedErrText;
      sharedLineError.style.display = sharedErrText ? 'block' : 'none';
      box.appendChild(sharedLineError);

      const lineFix = document.createElement('div');
      lineFix.className = 'error-text disk-line-fix';
      lineFix.textContent = 'Fix data disk/shared disk validation errors before generating the ARM template.';
      lineFix.style.display = (diskErrText || sharedErrText) ? 'block' : 'none';
      box.appendChild(lineFix);

      diskList.appendChild(box);
    });

    if (diskLimitErr) {
      const limitErr = document.createElement('div');
      limitErr.className = 'error-text';
      limitErr.textContent = diskLimitErr;
      diskList.appendChild(limitErr);
    }
  }

  /**
   * Syncs the Extra options storage panel UI with the current storage options state.
   * Updates checkbox states, share name input values, disabled states, validation
   */
  function renderStorageSection() {
    state.storageOptions = normalizeStorageOptions(state.storageOptions);
    const cfg = state.storageOptions;

    const enableSmb = $('enableSmbStorage');
    const enableNfs = $('enableNfsStorage');
    const smbWrap = $('smbShareFieldWrap');
    const nfsWrap = $('nfsShareFieldWrap');
    const smbShare = $('smbShareName');
    const nfsShare = $('nfsShareName');
    const smbErr = $('smbShareNameError');
    const nfsErr = $('nfsShareNameError');

    if (!enableSmb || !enableNfs || !smbWrap || !nfsWrap || !smbShare || !nfsShare || !smbErr || !nfsErr) return;

    enableSmb.checked = !!cfg.smbEnabled;
    enableNfs.checked = !!cfg.nfsEnabled;

    smbWrap.setAttribute('aria-hidden', cfg.smbEnabled ? 'false' : 'true');
    nfsWrap.setAttribute('aria-hidden', cfg.nfsEnabled ? 'false' : 'true');

    smbShare.value = cfg.smbShareName;
    nfsShare.value = cfg.nfsShareName;
    smbShare.disabled = !cfg.smbEnabled;
    nfsShare.disabled = !cfg.nfsEnabled;
    const errs = storageShareErrors();
    smbErr.textContent = errs.smb;
    nfsErr.textContent = errs.nfs;
  }

  /**
   * Renders the custom NSG rules list in the Extra options panel.
   * Each rule has protocol (TCP/UDP), destination port, and source (AzureCloud/Internet)
   * dropdowns/inputs with inline remove buttons. Rules are persisted to localStorage.
   */
  function renderCustomNsgRules() {
    const list = $('nsgRuleList');
    const noMsg = $('noNsgRuleMsg');
    if (!list || !noMsg) return;

    const rules = state.customNsgRules || [];
    noMsg.style.display = rules.length ? 'none' : 'block';
    list.innerHTML = '';

    rules.forEach((rule, idx) => {
      const box = document.createElement('div');
      box.className = 'box';
      box.style.marginTop = '6px';

      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:end;';

      const protoWrap = document.createElement('div');
      protoWrap.innerHTML = '<label>Protocol</label>';
      const protoSel = document.createElement('select');
      ['Tcp', 'Udp'].forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p.toUpperCase(); protoSel.appendChild(o); });
      protoSel.value = rule.protocol || 'Tcp';
      protoSel.onchange = (e) => { rule.protocol = e.target.value; updateOutput(); };
      protoWrap.appendChild(protoSel);

      const portWrap = document.createElement('div');
      portWrap.innerHTML = '<label>Destination port</label>';
      const portInput = document.createElement('input');
      portInput.value = String(rule.port || '');
      portInput.placeholder = '80 or 8080-8090';
      portInput.oninput = (e) => { rule.port = e.target.value.trim(); updateOutput(); };
      portWrap.appendChild(portInput);

      const srcWrap = document.createElement('div');
      srcWrap.innerHTML = '<label>Source</label>';
      const srcSel = document.createElement('select');
      ['AzureCloud', 'Internet'].forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; srcSel.appendChild(o); });
      srcSel.value = rule.source || 'AzureCloud';
      srcSel.onchange = (e) => { rule.source = e.target.value; updateOutput(); };
      srcWrap.appendChild(srcSel);

      const rmBtn = document.createElement('button');
      rmBtn.className = 'danger';
      rmBtn.textContent = 'Remove';
      rmBtn.style.fontSize = '12px';
      rmBtn.onclick = (e) => { e.stopPropagation(); state.customNsgRules.splice(idx, 1); renderCustomNsgRules(); updateOutput(); };

      grid.appendChild(protoWrap);
      grid.appendChild(portWrap);
      grid.appendChild(srcWrap);
      grid.appendChild(rmBtn);
      box.appendChild(grid);
      list.appendChild(box);
    });
  }

  /**
   * Shows or hides the Extra options overlay panel based on `state.extraOptionsOpen`.
   * Updates the toggle button's aria-expanded attribute and visual state.
   */
  function renderExtraOptionsPanel() {
    const panel = $('extraOptionsPanel');
    const btn = $('toggleExtraOptionsBtn');
    if (!panel || !btn) return;

    const open = !!state.extraOptionsOpen;
    panel.style.display = open ? 'block' : 'none';
    btn.textContent = 'Extra options';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /**
   * Normalizes and auto-corrects a single VM's configuration.
   * Ensures the VM has valid name, generation, disk controller, image, NIC defaults,
   * and accelerated networking settings for its current size. Coerces invalid disk SKUs.
   * This function is intentionally defensive and is called frequently before render/output.
   * @param {Object} vm - The VM model object (mutated in place).
   * @param {number} idx - The VM's index in the global `vms` array.
   * @returns {Object} The same VM object (for chaining).
   */
  function sanitizeVm(vm, idx) {
    // Single-VM normalization pass.
    // This function is intentionally defensive and is called frequently before render/output.
    vm.name = (vm.name || `vm${idx+1}`).trim() || `vm${idx+1}`;
    vm.customData = String(vm.customData || '');
    vm.rebootRequired = !!vm.rebootRequired;
    vm.publisherFilter = String(vm.publisherFilter || '');
    ensureNic(vm);
    vm.nics.forEach((n, i) => { n.name = (n.name || `nic${i+1}`).trim() || `nic${i+1}`; });

    const gens = allowedGenerationsFor(vm);
    if (!gens.includes(vm.gen)) vm.gen = gens[0];

    const ctls = allowedControllersFor(vm);
    if (!ctls.includes(vm.diskControllerType)) vm.diskControllerType = ctls[0];

    if (accelNetRequiredFor(vm)) vm.nics.forEach(n => n.accelerated = true);
    else if (!accelNetSupportedFor(vm)) vm.nics.forEach(n => n.accelerated = false);

    normalizeDataDiskSkus(vm);

    let imgs = filterImagesFor(vm);
    if (!imgs.length && vm.publisherFilter) {
      vm.publisherFilter = '';
      imgs = filterImagesFor(vm);
    }
    if (!imgs.find(i => i.key === vm.imageKey)) vm.imageKey = imgs[0] ? imgs[0].key : '';
    return vm;
  }

  /**
   * Clears per-cycle computation caches so the next render/updateOutput picks up fresh data.
   * Must be called at the start of {@link render} and {@link updateOutput}.
   */
  function invalidateCycleCaches() {
    // Clear per-cycle caches so the next computation picks up fresh data.
    state._imageCache = null;
    state._dupVmNamesCache = null;
  }

  /**
   * Runs {@link sanitizeVm} on every VM in the global `vms` array.
   * Called at the start of {@link updateOutput} to enforce all constraints.
   */
  function sanitizeAllVms() {
    // Global normalization pass: first sanitize each VM individually, then
    // run the cross-VM shared disk normalization. Order matters because
    // shared disk rules (max 2 attachments, property inheritance) depend on
    // each VM's disks already being individually valid (correct SKUs, etc.).
    vms.forEach((vm, idx) => sanitizeVm(vm, idx));
    normalizeSharedDisksGlobal();
  }

  /**
   * Main recompute step after any user change.
   * Pipeline: invalidate caches → sanitize all VMs → save state → render summaries →
   * validate (VM names, NIC names, disks, attachments, storage) → generate ARM JSON.
   * Disables output actions (copy/download/deploy) when validation errors exist.
   * Updates the output textarea with the generated ARM JSON or an error message.
   */
  function updateOutput() {
    // Main recompute step after any user change:
    // sanitize -> validate names -> generate ARM -> update textarea + summary.
    invalidateCycleCaches();
    sanitizeAllVms();
    saveUiState();
    renderVmSummaryTable();
    renderStorageSummary();

    const hasVmNameErrors = hasAnyVmNameErrors();
    const hasNicNameErrors = hasAnyNicNameErrors();
    const hasDiskErrors = hasAnyDiskValidationErrors();
    // Shared disk errors (e.g., >2 attachments, unsupported VM size) block ARM generation.
    const hasSharedDiskErrors = hasAnySharedDiskValidationErrors();
    const hasAttachmentErrors = hasAnyAttachmentLimitErrors();
    const hasStorageErrors = hasAnyStorageValidationErrors();
    const hasValidationErrors = hasVmNameErrors || hasNicNameErrors || hasDiskErrors || hasSharedDiskErrors || hasAttachmentErrors || hasStorageErrors
      ;

    $('copyBtn').disabled = hasValidationErrors;
    $('deployPortalBtn').disabled = hasValidationErrors;
    $('downloadBtn').disabled = hasValidationErrors;
    const copyBtnFlow = $('copyBtnFlow');
    const deployPortalBtnFlow = $('deployPortalBtnFlow');
    const downloadBtnFlow = $('downloadBtnFlow');
    if (copyBtnFlow) copyBtnFlow.disabled = hasValidationErrors;
    if (deployPortalBtnFlow) deployPortalBtnFlow.disabled = hasValidationErrors;
    if (downloadBtnFlow) downloadBtnFlow.disabled = hasValidationErrors;
    if (hasValidationErrors) {
      if (hasAttachmentErrors) {
        $('output').value = 'Fix VM size attachment limit errors (NIC/data disk counts) before generating the ARM template.';
      } else if (hasSharedDiskErrors) {
        $('output').value = 'Fix shared disk configuration errors in data disks before generating the ARM template.';
      } else if (hasStorageErrors) {
        $('output').value = 'Fix SMB/NFS share name validation errors in Extra options before generating the ARM template.';
      } else if (hasVmNameErrors && hasNicNameErrors && hasDiskErrors) {
        $('output').value = 'Fix VM, NIC, and data disk validation errors before generating the ARM template.';
      } else if (hasVmNameErrors && hasNicNameErrors) {
        $('output').value = 'Fix VM and NIC name errors before generating the ARM template.';
      } else if (hasVmNameErrors && hasDiskErrors) {
        $('output').value = 'Fix VM name and data disk validation errors before generating the ARM template.';
      } else if (hasNicNameErrors && hasDiskErrors) {
        $('output').value = 'Fix NIC and data disk validation errors before generating the ARM template.';
      } else if (hasVmNameErrors) {
        $('output').value = 'Fix VM name errors before generating the ARM template.';
      } else if (hasDiskErrors) {
        $('output').value = 'Fix data disk validation errors in the VM settings panel before generating the ARM template.';
      } else {
        $('output').value = 'Fix NIC validation errors in the VM settings panel before generating the ARM template.';
      }
      const outputFlowEl = $('outputFlow');
      if (outputFlowEl) outputFlowEl.value = $('output').value;
      return;
    }

    const arm = generateArmTemplate(vms, state.storageOptions);
    $('output').value = JSON.stringify(arm, null, 2);
    const outputFlowEl = $('outputFlow');
    if (outputFlowEl) outputFlowEl.value = $('output').value;
  }

  // ---------------------------------------------------------------------------
  // Targeted render helpers (avoid full DOM teardown for every interaction)
  // ---------------------------------------------------------------------------

  /**
   * Updates simple form field values for the active VM without creating or destroying DOM.
   * A targeted render helper used for lightweight updates (e.g. switching tabs).
   * Updates: VM meta text, name, custom data, reboot checkbox, size, and NIC/disk button states.
   * @param {Object} vm - The active VM model object.
   */
  function renderVmFormFields(vm) {
    // Update simple form field values — no DOM creation/destruction.
    $('vmMeta').textContent = `VM ${active + 1} of ${vms.length}`;
    $('vmName').value = vm.name;
    const nameErr = $('vmNameError');
    if (nameErr) nameErr.textContent = vmNameErrorAt(active);
    $('vmCustomData').value = vm.customData || '';
    $('vmRebootRequired').checked = !!vm.rebootRequired;
    $('vmSize').value = vm.size;
    updateNicDiskButtons(vm);
  }

  /**
   * Repopulates the generation, controller, publisher, and image dropdowns
   * for the active VM. A targeted render helper that avoids full DOM teardown.
   * @param {Object} vm - The active VM model object.
   */
  function renderVmSelects(vm) {
    // Repopulate the generation / controller / publisher / image dropdowns.
    populateGenSelect(vm);
    populateControllerSelect(vm);
    populatePublisherSelect(vm);
    populateImageSelect(vm);
  }

  /**
   * Refreshes the disabled state of the Add NIC and Add Disk buttons
   * based on the VM's current attachment counts vs. size limits.
   * @param {Object} vm - The active VM model object.
   */
  function updateNicDiskButtons(vm) {
    // Refresh the Add NIC / Add Disk button disabled state.
    $('addNicBtn').disabled = (vm.nics || []).length >= maxNicsFor(vm);
    $('addDiskBtn').disabled = (vm.disks || []).length >= maxDataDisksFor(vm);
  }

  /**
   * Patches NIC name maxLength attributes and error messages in-place
   * without rebuilding the full NIC DOM. Called when the VM name changes,
   * since the max NIC name length depends on the VM name length.
   * @param {Object} vm - The active VM model object.
   */
  function updateNicNameConstraints(vm) {
    // Patch NIC-name maxLength + error text in-place (avoids full NIC DOM rebuild).
    const maxLen = nicNameMaxLengthForVmName(vm.name);
    $('nicList').querySelectorAll('.box').forEach((box, idx) => {
      const nameInput = box.querySelector('.grid3 > div:first-child input');
      if (nameInput) nameInput.maxLength = maxLen;
      const nic = (vm.nics || [])[idx];
      if (nic) {
        const errText = nicNameError(vm, nic);
        const errEl = box.querySelector('.nic-line-error');
        if (errEl) { errEl.textContent = errText; errEl.style.display = errText ? 'block' : 'none'; }
        const fixEl = box.querySelector('.nic-line-fix');
        if (fixEl) fixEl.style.display = errText ? 'block' : 'none';
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Import ARM JSON → populate tool (best-effort, catalog-constrained)
  // ---------------------------------------------------------------------------
  /**
   * Imports an ARM template JSON string and populates the tool with extracted VMs.
   * Parses Microsoft.Compute/virtualMachines resources and matches vmSize and
   * imageReference to the local catalogs (case-insensitive). Imports NICs (name,
   * accelerated networking, public IP), data disks (size, SKU), and disk controller.
   * VMs whose size or image is not in the catalog are skipped.
   * Custom data is cleared on import (encoding cannot be reliably reversed).
   * Shows a summary toast with imported/skipped counts.
   * @param {string} jsonText - The raw JSON string of the ARM template.
   */
  function importFromArmJson(jsonText) {
    let template;
    try {
      template = JSON.parse(jsonText);
    } catch (e) {
      showToast('Import failed', 'The file is not valid JSON.');
      return;
    }

    const resources = template && template.resources;
    if (!Array.isArray(resources)) {
      showToast('Import failed', 'No "resources" array found in the JSON.');
      return;
    }

    // --- Collect storage options (SMB/NFS + share names) ---
    function parameterDefaultString(templateObj, parameterName) {
      const params = (templateObj && templateObj.parameters) || {};
      const p = params && params[parameterName];
      if (!p || typeof p !== 'object') return '';
      const dv = p.defaultValue;
      return (typeof dv === 'string') ? dv : '';
    }

    function extractShareNameFromShareResourceName(nameExpr, templateObj) {
      const raw = String(nameExpr || '').trim();
      if (!raw) return '';

      // First try parameter references in expression (use last one as likely share parameter).
      const paramMatches = Array.from(raw.matchAll(/parameters\('([^']+)'\)/g));
      if (paramMatches.length) {
        const lastParamName = String(paramMatches[paramMatches.length - 1][1] || '');
        const fromDefault = parameterDefaultString(templateObj, lastParamName);
        if (fromDefault) return fromDefault;
      }

      // Fallback for literal names: "account/default/share" or "default/share".
      const unwrapped = raw.replace(/^\[/, '').replace(/\]$/, '').replace(/'/g, '');
      const slashParts = unwrapped.split('/').map(p => p.trim()).filter(Boolean);
      if (slashParts.length >= 3) return slashParts[2];
      if (slashParts.length >= 2) return slashParts[1];

      return '';
    }

    const importedStorage = normalizeStorageOptions(state.storageOptions);
    importedStorage.smbEnabled = false;
    importedStorage.nfsEnabled = false;

    resources
      .filter(r => r.type === 'Microsoft.Storage/storageAccounts/fileServices/shares')
      .forEach(shareRes => {
        const props = (shareRes && shareRes.properties) || {};
        const protocol = String(props.enabledProtocols || '').toLowerCase();
        const shareNameRaw = extractShareNameFromShareResourceName(shareRes.name, template);

        if (protocol === 'smb') {
          importedStorage.smbEnabled = true;
          if (shareNameRaw) importedStorage.smbShareName = normalizeShareName(shareNameRaw, 'smbshare');
        }
        if (protocol === 'nfs') {
          importedStorage.nfsEnabled = true;
          if (shareNameRaw) importedStorage.nfsShareName = normalizeShareName(shareNameRaw, 'nfsshare');
        }
      });

    // --- Collect custom NSG rules (best-effort) ---
    function normalizeProtocolForImport(protocol) {
      const p = String(protocol || '').toLowerCase();
      if (p === 'tcp') return 'Tcp';
      if (p === 'udp') return 'Udp';
      return '';
    }

    function normalizeSourceForImport(source) {
      const s = String(source || '').toLowerCase();
      if (s === 'azurecloud') return 'AzureCloud';
      if (s === 'internet') return 'Internet';
      return '';
    }

    function isPortOrRange(value) {
      return /^\d+(-\d+)?$/.test(String(value || '').trim());
    }

    const importedCustomNsgRules = [];
    const importedCustomNsgRuleKeys = new Set();
    const nsgResources = resources.filter(r => r.type === 'Microsoft.Network/networkSecurityGroups');
    nsgResources.forEach(nsg => {
      const secRules = ((nsg && nsg.properties) ? nsg.properties.securityRules : null) || [];
      secRules.forEach(sr => {
        const props = (sr && sr.properties) || {};
        if (String(props.direction || '').toLowerCase() !== 'inbound') return;
        if (String(props.access || '').toLowerCase() !== 'allow') return;

        const protocol = normalizeProtocolForImport(props.protocol);
        const source = normalizeSourceForImport(props.sourceAddressPrefix);
        const port = String(props.destinationPortRange || '').trim();
        if (!protocol || !source || !isPortOrRange(port)) return;

        // Ignore the default SSH rule generated by this tool.
        const name = String((sr && sr.name) || '').toLowerCase();
        const isDefaultSshRule = name === 'inbound_ssh_azurecloud'
          || (protocol === 'Tcp' && source === 'AzureCloud' && port === '22' && Number(props.priority) === 100);
        if (isDefaultSshRule) return;

        const key = `${protocol}|${port}|${source}`;
        if (importedCustomNsgRuleKeys.has(key)) return;
        importedCustomNsgRuleKeys.add(key);
        importedCustomNsgRules.push({ protocol, port, source });
      });
    });

    // --- Collect NIC resources by name for later lookup ---
    const nicResources = new Map();
    resources.filter(r => r.type === 'Microsoft.Network/networkInterfaces').forEach(r => {
      nicResources.set(r.name, r);
    });

    // --- Collect PIP resource names for detecting publicIp ---
    const pipNames = new Set(
      resources.filter(r => r.type === 'Microsoft.Network/publicIPAddresses').map(r => r.name)
    );

    // --- Helper: resolve ARM resourceId reference to a plain name ---
    function extractNameFromResourceId(idExpr) {
      // Handles: "[resourceId('Microsoft.Network/networkInterfaces', 'vm1-nic1')]"
      const m = String(idExpr || '').match(/resourceId\([^,]+,\s*'([^']+)'\)/);
      return m ? m[1] : '';
    }

    // --- Helper: match an imageReference to our catalog ---
    function matchImage(imgRef) {
      if (!imgRef) return null;
      const pub = String(imgRef.publisher || '').toLowerCase();
      const off = String(imgRef.offer || '').toLowerCase();
      const sk  = String(imgRef.sku || '').toLowerCase();
      // Exact match on publisher + offer + sku
      return imageOptions.find(opt => {
        const r = opt.ref || {};
        return String(r.publisher || '').toLowerCase() === pub
            && String(r.offer    || '').toLowerCase() === off
            && String(r.sku      || '').toLowerCase() === sk;
      }) || null;
    }

    // --- Helper: match a vmSize to our catalog ---
    function matchSize(vmSizeName) {
      const lower = String(vmSizeName || '').toLowerCase();
      return sizeOptions.find(s => s.name.toLowerCase() === lower) || null;
    }

    // --- Extract VM resources ---
    const vmResources = resources.filter(r => r.type === 'Microsoft.Compute/virtualMachines');
    if (!vmResources.length) {
      showToast('Import failed', 'No Microsoft.Compute/virtualMachines resources found.');
      return;
    }

    const imported = [];
    const skipped = [];

    vmResources.forEach(vmRes => {
      const props = vmRes.properties || {};
      const vmName = String(vmRes.name || '').replace(/^\[|\]$/g, '').trim();
      // --- VM Size ---
      const rawSize = (props.hardwareProfile && props.hardwareProfile.vmSize) || '';
      const sizeMatch = matchSize(rawSize);
      if (!sizeMatch) {
        skipped.push(`${vmName || '(unnamed)'}: size '${rawSize}' not in catalog`);
        return;
      }

      // --- Image ---
      const imgRef = (props.storageProfile && props.storageProfile.imageReference) || {};
      const imageMatch = matchImage(imgRef);
      if (!imageMatch) {
        skipped.push(`${vmName}: image '${imgRef.publisher || ''}:${imgRef.offer || ''}:${imgRef.sku || ''}' not in catalog`);
        return;
      }

      // --- Disk controller ---
      const rawController = (props.storageProfile && props.storageProfile.diskControllerType) || '';
      const validControllers = ['SCSI', 'NVMe'];
      const diskControllerType = validControllers.includes(rawController) ? rawController : 'SCSI';

      // --- Generation (from matched image) ---
      const gen = imageMatch.gen || 'Gen2';

      // --- Custom data (cleared on import) ---
      const customData = '';

      // --- Reboot flag (can't be inferred from ARM, default false) ---
      const rebootRequired = false;

      // --- NICs ---
      const nicRefs = (props.networkProfile && props.networkProfile.networkInterfaces) || [];
      const nics = [];
      nicRefs.forEach((nicRef, idx) => {
        const fullNicName = extractNameFromResourceId(nicRef.id);
        // Derive the short NIC name by stripping the VM name prefix
        let shortName = fullNicName;
        if (fullNicName.toLowerCase().startsWith(vmName.toLowerCase() + '-')) {
          shortName = fullNicName.slice(vmName.length + 1);
        }

        // Check if this NIC has a public IP
        const nicRes = nicResources.get(fullNicName);
        let hasPublicIp = false;
        if (nicRes) {
          const ipConfigs = (nicRes.properties && nicRes.properties.ipConfigurations) || [];
          hasPublicIp = ipConfigs.some(ipc => {
            const ipcProps = ipc.properties || {};
            if (ipcProps.publicIPAddress) {
              const pipId = ipcProps.publicIPAddress.id || '';
              const pipName = extractNameFromResourceId(pipId);
              return pipNames.has(pipName);
            }
            return false;
          });
        }

        // Check accelerated networking
        const accel = nicRes && nicRes.properties && !!nicRes.properties.enableAcceleratedNetworking;

        nics.push({
          id: uid(),
          name: shortName || `nic${idx + 1}`,
          accelerated: accel,
          publicIp: hasPublicIp
        });
      });

      // --- Data disks ---
      const rawDisks = (props.storageProfile && props.storageProfile.dataDisks) || [];
      const validDiskSkus = Object.keys(maxDiskSizeGbBySku);
      const disks = rawDisks.map(d => {
        const rawSku = (d.managedDisk && d.managedDisk.storageAccountType) || '';
        const sku = validDiskSkus.includes(rawSku) ? rawSku : 'StandardSSD_LRS';
        return {
          sizeGB: Number(d.diskSizeGB) || LIMITS.DEFAULT_DATA_DISK_GB,
          sku: sku,
          // Imported disks are always non-shared. ARM templates use createOption: "Attach"
          // with resource IDs for shared disks, which can't be reliably mapped back to the
          // logical shared disk model during import.
          sharedEnabled: false,
          sharedDiskId: ''
        };
      });

      imported.push({
        id: uid(),
        name: vmName || `vm${imported.length + 1}`,
        size: sizeMatch.name,
        gen: gen,
        imageKey: imageMatch.key,
        diskControllerType: diskControllerType,
        publisherFilter: '',
        customData: customData,
        rebootRequired: rebootRequired,
        nics: nics.length ? nics : [defaultNic(0)],
        disks: disks
      });
    });

    if (!imported.length) {
      showToast('Import: nothing imported', `All ${vmResources.length} VM(s) skipped: ${skipped.join('; ')}`);
      return;
    }

    // Replace current VMs with imported ones
    state.vms = imported;
    state.storageOptions = importedStorage;
    state.customNsgRules = importedCustomNsgRules;
    state.activeVmIndex = 0;
    render();

    // Build summary
    const parts = [`Imported ${imported.length} VM(s).`];
    parts.push(`Storage: SMB ${importedStorage.smbEnabled ? 'on' : 'off'}, NFS ${importedStorage.nfsEnabled ? 'on' : 'off'}.`);
    parts.push(`Imported ${importedCustomNsgRules.length} custom NSG rule(s).`);
    if (skipped.length) parts.push(`Skipped ${skipped.length}: ${skipped.join('; ')}`);
    if (vmResources.some(r => (r.properties && r.properties.osProfile && r.properties.osProfile.customData))) {
      parts.push('Custom data was cleared during import.');
    }
    showToast('Import complete', parts.join(' '));
  }

  /**
   * Full UI render pipeline. Rebuilds tabs, selects, NICs, disks, hints, filters,
   * and the extra options panel from scratch. Used for tab switches, add/remove/clone VM,
   * filter changes, import, and initial page load.
   * For partial updates, prefer the targeted render helpers (renderVmFormFields,
   * renderVmSelects, updateNicDiskButtons, etc.) to avoid unnecessary DOM teardown.
   */
  function render() {
    // Full UI render pipeline — use for tab switches, add/remove VM, initial load.
    // For partial updates prefer the targeted helpers above.
    invalidateCycleCaches();
    renderSizeFilterChips();
    renderTabs();

    const vm = vms[active];

    alignVmSizeToActiveFilters(vm);
    sanitizeVm(vm, active);
    // Shared disk normalization must run after sanitizeVm to ensure cross-VM
    // constraints (max 2 attachments, property sync) are enforced before rendering.
    normalizeSharedDisksGlobal();

    populateSizeSelect(vm);
    renderVmFormFields(vm);
    renderVmSelects(vm);
    renderHints(vm);
    renderNics(vm);
    renderDisks(vm);
    renderExtraOptionsPanel();
    renderStorageSection();
    renderCustomNsgRules();

    updateOutput();
  }

  // ---------------------------------------------------------------------------
  // Event wiring (mutations happen here, then render()/updateOutput() keeps UI consistent)
  // ---------------------------------------------------------------------------
  // Pattern:
  // - mutate active VM model
  // - auto-correct incompatible fields when needed
  // - optionally show toast for user awareness
  // - call render() (full refresh) or updateOutput() (cheap refresh)
  // ---------------------------------------------------------------------------
  // Events
  // --- Filter panel helpers (open / close / focus-trap) ---
  /**
   * Opens the VM size filter panel dialog. Renders the filter fields and
   * focuses the first interactive element inside the panel.
   */
  function openFilterPanel() {
    const p = $('sizeFilterPanel');
    if (!p) return;
    renderSizeFilterPanelFields();
    p.style.display = 'block';
    const first = p.querySelector('select, button, input');
    if (first) first.focus();
  }
  /**
   * Closes the VM size filter panel dialog.
   * @param {boolean} returnFocus - If true, returns focus to the "+ Add VM filter" button.
   */
  function closeFilterPanel(returnFocus) {
    const p = $('sizeFilterPanel');
    if (p) p.style.display = 'none';
    if (returnFocus) $('addSizeFilterBtn').focus();
  }
  /**
   * Returns whether the VM size filter panel is currently visible.
   * @returns {boolean} True if the filter panel is open.
   */
  function filterPanelIsOpen() {
    const p = $('sizeFilterPanel');
    return p && p.style.display !== 'none';
  }
  // Focus trap: keep Tab cycling inside the open panel
  $('sizeFilterPanel').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeFilterPanel(true); return; }
    if (e.key !== 'Tab') return;
    const panel = $('sizeFilterPanel');
    const focusable = panel.querySelectorAll('select, button, input, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  $('addSizeFilterBtn').onclick = () => {
    filterPanelIsOpen() ? closeFilterPanel(false) : openFilterPanel();
  };
  $('sizeFilterOkBtn').onclick = () => {
    const grid = $('sizeFilterGrid');
    if (grid) {
      grid.querySelectorAll('select[data-filter-key]').forEach((sel) => {
        const key = sel.getAttribute('data-filter-key');
        if (!key) return;
        sizeFilters[key] = sel.value || '';
      });
    }
    closeFilterPanel(true);
    render();
  };
  $('sizeFilterCancelBtn').onclick = () => {
    closeFilterPanel(true);
  };
  document.addEventListener('click', (e) => {
    const panel = $('sizeFilterPanel');
    const wrap = document.querySelector('.size-filter-wrap');
    if (!panel || !wrap) return;
    if (!wrap.contains(e.target)) closeFilterPanel(false);
  });
  $('sizeFilterChips').onclick = (e) => {
    const btn = e.target.closest('[data-filter-key]');
    if (!btn) return;
    const key = btn.getAttribute('data-filter-key');
    if (!key) return;
    sizeFilters[key] = '';
    render();
  };
  $('clearSizeFiltersBtn').onclick = () => {
    sizeFilters.family = '';
    sizeFilters.arch = '';
    sizeFilters.gen = '';
    sizeFilters.controller = '';
    sizeFilters.diskSku = '';
    sizeFilters.accel = '';
    sizeFilters.ephemeral = '';
    sizeFilters.minNics = '';
    sizeFilters.minDataDisks = '';
    render();
  };

  $('addVmBtn').onclick = () => {
    const vmName = nextDefaultVmName();
    const filtered = filteredSizeOptions();
    const defaultSize = (filtered[0] || sizeOptions[0]).name;
    const vm = {
      id: uid(),
      name: vmName,
      size: defaultSize,
      gen: allowedGenerationsFor({size: defaultSize})[0],
      imageKey: '',
      diskControllerType: allowedControllersFor({size: defaultSize})[0],
      publisherFilter: '',
      customData: '',
      rebootRequired: false,
      nics: [ defaultNic(0) ],
      disks: []
    };
    const imgs = filterImagesFor(vm);
    vm.imageKey = imgs[0] ? imgs[0].key : '';
    vms.push(vm);
    active = vms.length - 1;
    render();
  };

  $('cloneVmBtn').onclick = () => {
    const src = vms[active];
    if (!src) return;

    const clone = {
      ...src,
      id: uid(),
      name: nextCloneVmName(src.name),
      publisherFilter: String(src.publisherFilter || ''),
      customData: String(src.customData || ''),
      nics: (src.nics || []).map((n, i) => ({
        ...n,
        id: uid(),
        name: String(n.name || `nic${i+1}`)
      })),
      // Cloned disks are reset to non-shared. Inheriting shared disk IDs would
      // silently create a third attachment (exceeding maxShares=2) or cause
      // unintended cross-VM disk sharing.
      disks: (src.disks || []).map(d => ({
        ...d,
        sharedEnabled: false,
        sharedDiskId: ''
      }))
    };

    vms.push(clone);
    active = vms.length - 1;
    render();
  };

  $('removeVmBtn').onclick = () => {
    if (vms.length <= 1) return;
    vms.splice(active, 1);
    active = Math.max(0, active - 1);
    render();
  };

  $('addNicBtn').onclick = () => {
    const vm = vms[active];
    ensureNic(vm);
    if ((vm.nics || []).length >= maxNicsFor(vm)) {
      showToast('NIC limit reached', `VM size '${vm.size}' supports up to ${maxNicsFor(vm)} NIC(s).`);
      return;
    }
    const nic = defaultNic(vm.nics.length);
    nic.name = nextDefaultNicName(vm);
    vm.nics.push(nic);
    renderNics(vm);
    updateNicDiskButtons(vm);
    updateOutput();
  };
  $('addDiskBtn').onclick = () => {
    const vm = vms[active];
    vm.disks = vm.disks || [];
    if ((vm.disks || []).length >= maxDataDisksFor(vm)) {
      showToast('Data disk limit reached', `VM size '${vm.size}' supports up to ${maxDataDisksFor(vm)} data disk(s).`);
      return;
    }
    // New disks start as normal (non-shared). Use "Enable shared disk" to convert.
    vm.disks.push({
      sizeGB: LIMITS.DEFAULT_DATA_DISK_GB,
      sku: defaultDiskSkuFor(vm),
      sharedEnabled: false,
      sharedDiskId: ''
    });
    renderDisks(vm);
    updateNicDiskButtons(vm);
    updateOutput();
  };

  $('vmName').oninput = (e) => {
    vms[active].name = e.target.value;
    renderTabs();
    updateNicNameConstraints(vms[active]);
    const nameErr = $('vmNameError');
    if (nameErr) {
      nameErr.textContent = vmNameErrorAt(active);
    }
    updateOutput();
  };
  $('vmCustomData').oninput = (e) => {
    vms[active].customData = e.target.value || '';
    updateOutput();
  };
  $('vmRebootRequired').onchange = (e) => {
    vms[active].rebootRequired = !!e.target.checked;
    updateOutput();
  };
  $('vmSize').onchange = (e) => {
  const vm = vms[active];
  const prevGen = vm.gen;
  const prevCtl = vm.diskControllerType;
  const prevImageKey = vm.imageKey;
  vm.size = e.target.value;

  // Size may constrain generation + controller.
  const gens = allowedGenerationsFor(vm);
  if (!gens.includes(vm.gen)) vm.gen = gens[0];
  const ctls = allowedControllersFor(vm);
  if (!ctls.includes(vm.diskControllerType)) vm.diskControllerType = ctls[0];

  // Image may be forced by architecture/gen/controller filters.
  const imgs = filterImagesFor(vm);
  if (!imgs.find(i => i.key === vm.imageKey)) vm.imageKey = imgs[0] ? imgs[0].key : '';
  const changedSkus = normalizeDataDiskSkus(vm);
  // If the new VM size doesn't support shared disks, convert all shared disks
  // on this VM to normal (non-shared) disks. This prevents invalid ARM output.
  const convertedSharedDisks = sharedDiskSupportedFor(vm) ? 0 : convertSharedDisksToNormalOnVm(vm);

  if (prevGen !== vm.gen && prevCtl !== vm.diskControllerType) {
    showToast('Adjusted VM settings', `Size changed. Gen '${prevGen}'→'${vm.gen}', Controller '${prevCtl}'→'${vm.diskControllerType}'.`);
  } else if (prevGen !== vm.gen) {
    showToast('Adjusted VM generation', `Size changed. Gen '${prevGen}' isn't supported, switched to '${vm.gen}'.`);
  } else if (prevCtl !== vm.diskControllerType) {
    showToast('Adjusted disk controller', `Size changed. Controller '${prevCtl}' isn't supported, switched to '${vm.diskControllerType}'.`);
  }

  if (prevImageKey !== vm.imageKey) {
    const prevLabel = (imageByKey(prevImageKey) || {}).label || prevImageKey || 'previous image';
    const nextLabel = (imageByKey(vm.imageKey) || {}).label || vm.imageKey || 'no image';
    showToast('Adjusted OS image', `Size architecture/capabilities changed. '${prevLabel}' → '${nextLabel}'.`);
  }

  if (changedSkus > 0) {
    showToast('Adjusted data disk SKU', `Size changed. ${changedSkus} data disk(s) were switched to supported SKU values.`);
  }

  if (convertedSharedDisks > 0) {
    showToast('Adjusted shared disks', `Size '${vm.size}' does not support shared disks. ${convertedSharedDisks} shared disk(s) were converted to normal disks.`);
  }

  const nicOverflow = (vm.nics || []).length - maxNicsFor(vm);
  if (nicOverflow > 0) {
    showToast('NIC count exceeds size limit', `Size '${vm.size}' supports up to ${maxNicsFor(vm)} NIC(s). Remove ${nicOverflow} NIC(s).`);
  }

  const diskOverflow = (vm.disks || []).length - maxDataDisksFor(vm);
  if (diskOverflow > 0) {
    showToast('Data disk count exceeds size limit', `Size '${vm.size}' supports up to ${maxDataDisksFor(vm)} data disk(s). Remove ${diskOverflow} disk(s).`);
  }

  renderVmSelects(vm);
  renderHints(vm);
  renderNics(vm);
  renderDisks(vm);
  updateNicDiskButtons(vm);
  updateOutput();
};
  $('vmGen').onchange = (e) => {
  const vm = vms[active];
  const prevCtl = vm.diskControllerType;
  const prevImageKey = vm.imageKey;
  vm.gen = e.target.value;

  // If controller is no longer allowed for selected generation, auto-fix and explain.
  const allowed = allowedControllersFor(vm);
  if (!allowed.includes(vm.diskControllerType)) {
    vm.diskControllerType = allowed[0];
    showToast('Adjusted disk controller', `Selected ${vm.gen}. Controller '${prevCtl}' isn't supported, switched to '${vm.diskControllerType}'.`);
  }

  const imgs = filterImagesFor(vm);
  if (!imgs.find(i => i.key === vm.imageKey)) {
    vm.imageKey = imgs[0] ? imgs[0].key : '';
    const prevLabel = (imageByKey(prevImageKey) || {}).label || prevImageKey || 'previous image';
    const nextLabel = (imageByKey(vm.imageKey) || {}).label || vm.imageKey || 'no image';
    showToast('Adjusted OS image', `Generation/controller changed. '${prevLabel}' → '${nextLabel}'.`);
  }

  populateControllerSelect(vm);
  populateImageSelect(vm);
  renderHints(vm);
  updateOutput();
};
  $('vmImage').onchange = (e) => { vms[active].imageKey = e.target.value; updateOutput(); };
  $('vmPublisher').onchange = (e) => {
    const vm = vms[active];
    const prevImageKey = vm.imageKey;
    vm.publisherFilter = e.target.value || '';
    const imgs = filterImagesFor(vm);
    if (!imgs.find(i => i.key === vm.imageKey)) vm.imageKey = imgs[0] ? imgs[0].key : '';
    if (prevImageKey !== vm.imageKey) {
      const prevLabel = (imageByKey(prevImageKey) || {}).label || prevImageKey || 'previous image';
      const nextLabel = (imageByKey(vm.imageKey) || {}).label || vm.imageKey || 'no image';
      showToast('Adjusted OS image', `Publisher filter changed. '${prevLabel}' → '${nextLabel}'.`);
    }
    populateImageSelect(vm);
    updateOutput();
  };
  $('diskController').onchange = (e) => {
    const vm = vms[active];
    const prevImageKey = vm.imageKey;
    vm.diskControllerType = e.target.value;

    const imgs = filterImagesFor(vm);
    if (!imgs.find(i => i.key === vm.imageKey)) {
      vm.imageKey = imgs[0] ? imgs[0].key : '';
      const prevLabel = (imageByKey(prevImageKey) || {}).label || prevImageKey || 'previous image';
      const nextLabel = (imageByKey(vm.imageKey) || {}).label || vm.imageKey || 'no image';
      showToast('Adjusted OS image', `Disk controller changed. '${prevLabel}' → '${nextLabel}'.`);
    }

    populateImageSelect(vm);
    renderHints(vm);
    updateOutput();
  };

  $('toggleExtraOptionsBtn').onclick = () => {
    state.extraOptionsOpen = !state.extraOptionsOpen;
    renderExtraOptionsPanel();
    saveUiState();
  };

  document.addEventListener('click', (e) => {
    const panel = $('extraOptionsPanel');
    const toggleBtn = $('toggleExtraOptionsBtn');
    if (!panel || !toggleBtn || !state.extraOptionsOpen) return;

    const target = e.target;
    if (panel.contains(target) || toggleBtn.contains(target)) return;

    state.extraOptionsOpen = false;
    renderExtraOptionsPanel();
    saveUiState();
  });

  $('enableSmbStorage').onchange = (e) => {
    state.storageOptions.smbEnabled = !!e.target.checked;
    renderStorageSection();
    updateOutput();
  };

  $('enableNfsStorage').onchange = (e) => {
    state.storageOptions.nfsEnabled = !!e.target.checked;
    renderStorageSection();
    updateOutput();
  };

  $('smbShareName').oninput = (e) => {
    state.storageOptions.smbShareName = String(e.target.value || '');
    renderStorageSection();
    updateOutput();
  };

  $('nfsShareName').oninput = (e) => {
    state.storageOptions.nfsShareName = String(e.target.value || '');
    renderStorageSection();
    updateOutput();
  };
  $('addNsgRuleBtn').onclick = () => {
    state.customNsgRules = state.customNsgRules || [];
    state.customNsgRules.push({ protocol: 'Tcp', port: '', source: 'AzureCloud' });
    renderCustomNsgRules();
    updateOutput();
  };

  function getOutputJsonText() {
    return String(($('output') && $('output').value) || '');
  }

  function syncFlowOutputText() {
    const flowOutput = $('outputFlow');
    if (flowOutput) flowOutput.value = getOutputJsonText();
  }

  function setCopyFeedback(btnId) {
    const buttonEl = $(btnId);
    if (!buttonEl) return;
    buttonEl.textContent = 'Copied!';
    setTimeout(() => {
      buttonEl.textContent = 'Copy';
    }, LIMITS.COPY_FEEDBACK_MS);
  }

  async function runCopyAction(feedbackBtnId) {
    try {
      await navigator.clipboard.writeText(getOutputJsonText());
      setCopyFeedback(feedbackBtnId);
    } catch (e) {
      alert('Clipboard copy failed. You can manually copy from the textarea.');
    }
  }

  async function runDeployPortalAction(btnId) {
    try {
      await navigator.clipboard.writeText(getOutputJsonText());
      const url = 'https://portal.azure.com/#create/Microsoft.Template';
      const btn = $(btnId);
      const originalText = btn ? btn.textContent : 'Copy + Portal';

      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Opening in 5s...';
      }

      showDeployFlow('ARM JSON copied to clipboard. In Custom deployment, choose "Build your own template in the editor", then paste the JSON from clipboard. If the portal does not open, allow pop-up windows for this page.', LIMITS.DEPLOY_COUNTDOWN_S);

      setTimeout(() => {
        window.open(url, '_blank', 'noopener');
        if (btn) {
          btn.textContent = originalText;
          btn.disabled = false;
        }
      }, LIMITS.DEPLOY_COUNTDOWN_S * 1000);
    } catch (e) {
      alert('Unable to copy JSON and open Azure portal automatically. Please copy manually, then open https://portal.azure.com/#create/Microsoft.Template');
    }
  }

  function runDownloadAction() {
    const blob = new Blob([getOutputJsonText()], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'azuredeploy.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function openJsonFlowWindow() {
    const flowWindow = $('jsonFlowWindow');
    if (!flowWindow) return;
    syncFlowOutputText();
    flowWindow.classList.add('show');
  }

  function closeJsonFlowWindow() {
    const flowWindow = $('jsonFlowWindow');
    if (!flowWindow) return;
    flowWindow.classList.remove('show');
  }

  $('openJsonExpandedBtn').onclick = () => {
    openJsonFlowWindow();
  };

  $('closeJsonFlowBtn').onclick = () => {
    closeJsonFlowWindow();
  };

  $('copyBtn').onclick = async () => {
    await runCopyAction('copyBtn');
  };

  $('copyBtnFlow').onclick = async () => {
    await runCopyAction('copyBtnFlow');
  };

  $('deployPortalBtn').onclick = async () => {
    await runDeployPortalAction('deployPortalBtn');
  };

  $('deployPortalBtnFlow').onclick = async () => {
    await runDeployPortalAction('deployPortalBtnFlow');
  };

  $('downloadBtn').onclick = () => {
    runDownloadAction();
  };

  $('downloadBtnFlow').onclick = () => {
    runDownloadAction();
  };

  $('importBtnFlow').onclick = () => { $('importFileInput').click(); };

  $('importBtn').onclick = () => { $('importFileInput').click(); };
  $('importFileInput').onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      importFromArmJson(reader.result);
      // Reset input so re-importing the same file triggers onchange again
      $('importFileInput').value = '';
    };
    reader.onerror = () => showToast('Import failed', 'Could not read the selected file.');
    reader.readAsText(file);
  };

  $('helpBtn').onclick = (e) => {
    e.stopPropagation();
    const balloon = $('helpBalloon');
    if (!balloon) return;
    const nextShow = !balloon.classList.contains('show');
    balloon.classList.toggle('show', nextShow);
    balloon.setAttribute('aria-hidden', nextShow ? 'false' : 'true');
  };

  document.addEventListener('click', (e) => {
    const balloon = $('helpBalloon');
    const wrap = document.querySelector('.help-wrap');
    if (!balloon || !wrap) return;
    if (!wrap.contains(e.target)) {
      balloon.classList.remove('show');
      balloon.setAttribute('aria-hidden', 'true');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeJsonFlowWindow();
    // Close filter panel if open (focus-trap handler above takes priority when focus is inside)
    if (filterPanelIsOpen()) { closeFilterPanel(true); }
    const balloon = $('helpBalloon');
    if (!balloon) return;
    balloon.classList.remove('show');
    balloon.setAttribute('aria-hidden', 'true');
  });

  function bootstrapApp() {
    render();
  }

  if (document.readyState === 'complete') {
    bootstrapApp();
  } else {
    window.addEventListener('load', bootstrapApp, { once: true });
  }
