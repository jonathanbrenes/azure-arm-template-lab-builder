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

globalThis.ARM_BUILDER_SIZE_OPTIONS = [
  // -------------------------------------------------------------------------
  // B-family (burstable)
  // -------------------------------------------------------------------------
  // Standard_B2s: Small burstable x64 size for lightweight labs.
  {
    name: 'Standard_B2s',
    tags: {
      architectures: ['x64'],
      generations: ['Gen1','Gen2'],
      diskControllersByGen: {
        Gen1: ['SCSI'],
        Gen2: ['SCSI']
      },
      diskSkuSupport: {
        Standard_LRS: true,
        StandardSSD_LRS: true,
        Premium_LRS: false,
        PremiumV2_LRS: false,
        UltraSSD_LRS: true
      },
      sharedDiskSupported: false,
      accelNetMode: 'unsupported',
      ephemeralOsDiskSupported: true,      
      maxNics: 3,
      maxDataDisks: 4
    }
  },

  // -------------------------------------------------------------------------
  // D-family (general purpose)
  // -------------------------------------------------------------------------
  // Standard_D2s_v3: General-purpose x64 v3 with broad Gen1/Gen2 compatibility.
  {
    name: 'Standard_D2s_v3',
    tags: {
      architectures: ['x64'],
      generations: ['Gen1','Gen2'],
      diskControllersByGen: {
        Gen1: ['SCSI'],
        Gen2: ['SCSI']
      },
      diskSkuSupport: {
        Standard_LRS: true,
        StandardSSD_LRS: true,
        Premium_LRS: true,
        PremiumV2_LRS: false,
        UltraSSD_LRS: true
      },
      sharedDiskSupported: false,
      accelNetMode: 'optional',
      ephemeralOsDiskSupported: true,      
      maxNics: 2,
      maxDataDisks: 4
    }
  },

  // Standard_D2s_v6: Newer x64 v6 size with NVMe on Gen2.
  {
    name: 'Standard_D2s_v6',
    tags: {
      architectures: ['x64'],
      generations: ['Gen2'],
      diskControllersByGen: {
        Gen2: ['NVMe']
      },
      diskSkuSupport: {
        Standard_LRS: true,
        StandardSSD_LRS: true,
        Premium_LRS: true,
        PremiumV2_LRS: true,
        UltraSSD_LRS: true
      },
      sharedDiskSupported: false,
      accelNetMode: 'optional',
      ephemeralOsDiskSupported: false,      
      maxNics: 2,
      maxDataDisks: 8
    }
  },

  // Standard_D2ps_v6: Arm64 v6 general-purpose size.
  {
    name: 'Standard_D2ps_v6',
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
      sharedDiskSupported: false,
      accelNetMode: 'optional',
      ephemeralOsDiskSupported: false,
      maxNics: 2,
      maxDataDisks: 8
    }
  },

  // Standard_D4s_v5: Common x64 lab size with required accelerated networking.
  {
    name: 'Standard_D4s_v5',
    tags: {
      architectures: ['x64'],
      generations: ['Gen1','Gen2'],
      diskControllersByGen: {
        Gen1: ['SCSI'],
        Gen2: ['SCSI']
      },
      diskSkuSupport: {
        Standard_LRS: true,
        StandardSSD_LRS: true,
        Premium_LRS: true,
        PremiumV2_LRS: false,
        UltraSSD_LRS: true
      },
      sharedDiskSupported: false,
      accelNetMode: 'required',
      ephemeralOsDiskSupported: false,
      maxNics: 2,
      maxDataDisks: 8
    }
  },

  // Standard_D4ls_v5: Storage-focused x64 D-series variant.
  {
    name: 'Standard_D4ls_v5',
    tags: {
      architectures: ['x64'],
      generations: ['Gen1','Gen2'],
      diskControllersByGen: {
        Gen1: ['SCSI'],
        Gen2: ['SCSI']
      },
      diskSkuSupport: {
        Standard_LRS: true,
        StandardSSD_LRS: true,
        Premium_LRS: true,
        PremiumV2_LRS: false,
        UltraSSD_LRS: true
      },
      sharedDiskSupported: false,
      accelNetMode: 'optional',
      ephemeralOsDiskSupported: false,
      maxNics: 2,
      maxDataDisks: 8
    }
  },

  // -------------------------------------------------------------------------
  // E-family (memory optimized)
  // -------------------------------------------------------------------------
  // Standard_E2bds_v5: Memory-optimized x64 with NVMe support on Gen2.
  // NOTE: This is currently the only catalog entry with sharedDiskSupported=true.
  //       When adding new sizes, verify shared disk support via Azure portal or docs
  //       (az vm list-skus is unreliable for this capability).
  {
    name: 'Standard_E2bds_v5',
    tags: {
      architectures: ['x64'],
      generations: ['Gen1','Gen2'],
      diskControllersByGen: {
        Gen1: ['SCSI'],
        Gen2: ['SCSI','NVMe']
      },
      diskSkuSupport: {
        Standard_LRS: true,
        StandardSSD_LRS: true,
        Premium_LRS: true,
        PremiumV2_LRS: true,
        UltraSSD_LRS: true
      },
      sharedDiskSupported: true,
      accelNetMode: 'optional',
      ephemeralOsDiskSupported: true,
      maxNics: 2,
      maxDataDisks: 4
    }
  },

  // Standard_E2ps_v6: Arm64 memory-optimized v6 size for lightweight workloads.
  {
    name: 'Standard_E2ps_v6',
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
      sharedDiskSupported: false,
      accelNetMode: 'optional',
      ephemeralOsDiskSupported: false,
      maxNics: 2,
      maxDataDisks: 8
    }
  },

  // Standard_E32bds_v5: Larger memory-optimized x64 option for heavier labs.
  {
    name: 'Standard_E32bds_v5',
    tags: {
      architectures: ['x64'],
      generations: ['Gen1','Gen2'],
      diskControllersByGen: {
        Gen1: ['SCSI'],
        Gen2: ['SCSI','NVMe']
      },
      diskSkuSupport: {
        Standard_LRS: true,
        StandardSSD_LRS: true,
        Premium_LRS: true,
        PremiumV2_LRS: true,
        UltraSSD_LRS: true
      },
      sharedDiskSupported: false,
      accelNetMode: 'optional',
      ephemeralOsDiskSupported: true,      
      maxNics: 8,
      maxDataDisks: 32
    }
  },

  // -------------------------------------------------------------------------
  // F-family (compute optimized)
  // -------------------------------------------------------------------------
  // Standard_F2s_v2: Compute-oriented x64 size with balanced limits.
  {
    name: 'Standard_F2s_v2',
    tags: {
      architectures: ['x64'],
      generations: ['Gen1','Gen2'],
      diskControllersByGen: {
        Gen1: ['SCSI'],
        Gen2: ['SCSI']
      },
      diskSkuSupport: {
        Standard_LRS: true,
        StandardSSD_LRS: true,
        Premium_LRS: true,
        PremiumV2_LRS: false,
        UltraSSD_LRS: true
      },
      sharedDiskSupported: false,
      accelNetMode: 'optional',
      ephemeralOsDiskSupported: true,      
      maxNics: 2,
      maxDataDisks: 4
    }
  },

  // -------------------------------------------------------------------------
  // L-family (storage optimized)
  // -------------------------------------------------------------------------
  // Standard_L8as_v3: Storage-optimized x64 size with higher disk/NIC capacity.
  {
    name: 'Standard_L8as_v3',
    tags: {
      architectures: ['x64'],
      generations: ['Gen1','Gen2'],
      diskControllersByGen: {
        Gen1: ['SCSI'],
        Gen2: ['SCSI']
      },
      diskSkuSupport: {
        Standard_LRS: true,
        StandardSSD_LRS: true,
        Premium_LRS: true,
        PremiumV2_LRS: false,
        UltraSSD_LRS: true
      },
      sharedDiskSupported: false,
      accelNetMode: 'optional',
      ephemeralOsDiskSupported: true,      
      maxNics: 4,
      maxDataDisks: 16
    }
  }
];
