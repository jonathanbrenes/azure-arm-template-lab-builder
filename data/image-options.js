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

globalThis.ARM_BUILDER_IMAGE_OPTIONS = [
    // RedHat

    { key: 'rhel_10_1_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL 10.1 (Gen1) (RedHat:RHEL:10_1:latest)',
      ref: { publisher:'RedHat', offer:'RHEL', sku:'10_1', version:'latest' } },

    { key: 'rhel_10_lvm_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'RHEL 10 (Gen2) (RedHat:RHEL:10-lvm-gen2:latest)',
      ref: { publisher:'RedHat', offer:'RHEL', sku:'10-lvm-gen2', version:'latest' } },

    { key: 'rhel_7_6_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL:7.6 (Gen1) (RedHat:RHEL:7.6:latest)',
      ref: { publisher:'RedHat', offer:'RHEL', sku:'7.6', version:'latest' } },

    { key: 'rhel_7_8_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL:7.8 (Gen1) (RedHat:RHEL:7.8:latest)',
      ref: { publisher:'RedHat', offer:'RHEL', sku:'7.8', version:'latest' } },

    { key: 'rhel_8_9_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL 8.9 (Gen1) (RedHat:RHEL:8_9:latest)',
      ref: { publisher:'RedHat', offer:'RHEL', sku:'8_9', version:'latest' } },

    { key: 'rhel_8_lvm_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'RHEL 8 (Gen2) (RedHat:RHEL:8-lvm-gen2:latest)',
      ref: { publisher:'RedHat', offer:'RHEL', sku:'8-lvm-gen2', version:'latest' } },

    { key: 'rhel_9_7_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL 9.7 (Gen1) (RedHat:RHEL:9_7:latest)',
      ref: { publisher:'RedHat', offer:'RHEL', sku:'9_7', version:'latest' } },

    { key: 'rhel_9_lvm_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'RHEL 9 (Gen2) (RedHat:RHEL:9-lvm-gen2:latest)',
      ref: { publisher:'RedHat', offer:'RHEL', sku:'9-lvm-gen2', version:'latest' } },

    { key: 'rhel_arm64_10_1_arm64_arm64_gen2', arch: 'Arm64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'RHEL 10.1 Arm64 (Gen2) (RedHat:rhel-arm64:10_1-arm64:latest)',
      ref: { publisher:'RedHat', offer:'rhel-arm64', sku:'10_1-arm64', version:'latest' } },

    { key: 'rhel_arm64_8_10_arm64_arm64_gen2', arch: 'Arm64', gen: 'Gen2', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL 8.10 Arm64 (Gen2) (RedHat:rhel-arm64:8_10-arm64:latest)',
      ref: { publisher:'RedHat', offer:'rhel-arm64', sku:'8_10-arm64', version:'latest' } },

    { key: 'rhel_arm64_9_7_arm64_arm64_gen2', arch: 'Arm64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'RHEL 9.7 Arm64 (Gen2) (RedHat:rhel-arm64:9_7-arm64:latest)',
      ref: { publisher:'RedHat', offer:'rhel-arm64', sku:'9_7-arm64', version:'latest' } },

    { key: 'rhel_raw_10_1_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL Raw 10.1 (Gen1) (RedHat:rhel-raw:10_1:latest)',
      ref: { publisher:'RedHat', offer:'rhel-raw', sku:'10_1', version:'latest' } },

    { key: 'rhel_raw_10_raw_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'RHEL Raw 10 (Gen2) (RedHat:rhel-raw:10-raw-gen2:latest)',
      ref: { publisher:'RedHat', offer:'rhel-raw', sku:'10-raw-gen2', version:'latest' } },

    { key: 'rhel_raw_10_raw_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL Raw 10 (Gen1) (RedHat:rhel-raw:10-raw:latest)',
      ref: { publisher:'RedHat', offer:'rhel-raw', sku:'10-raw', version:'latest' } },

    { key: 'rhel_raw_89_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL Raw 8.9 (Gen2) (RedHat:rhel-raw:89-gen2:latest)',
      ref: { publisher:'RedHat', offer:'rhel-raw', sku:'89-gen2', version:'latest' } },

    { key: 'rhel_raw_8_4_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL Raw 8.4 (Gen1) (RedHat:rhel-raw:8_4:latest)',
      ref: { publisher:'RedHat', offer:'rhel-raw', sku:'8_4', version:'latest' } },

    { key: 'rhel_raw_8_9_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL Raw 8.9 (Gen1) (RedHat:rhel-raw:8_9:latest)',
      ref: { publisher:'RedHat', offer:'rhel-raw', sku:'8_9', version:'latest' } },

    { key: 'rhel_raw_8_raw_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL Raw 8 (Gen2) (RedHat:rhel-raw:8-raw-gen2:latest)',
      ref: { publisher:'RedHat', offer:'rhel-raw', sku:'8-raw-gen2', version:'latest' } },

    { key: 'rhel_raw_8_raw_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL Raw 8 (Gen1) (RedHat:rhel-raw:8-raw:latest)',
      ref: { publisher:'RedHat', offer:'rhel-raw', sku:'8-raw', version:'latest' } },

    { key: 'rhel_raw_9_5_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL Raw 9.5 (Gen1) (RedHat:rhel-raw:9_5:latest)',
      ref: { publisher:'RedHat', offer:'rhel-raw', sku:'9_5', version:'latest' } },
    
    { key: 'rhel_ha_8_8_x64_gen1_latest', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'RHEL HA x86_64 (Gen1) (RedHat:RHEL-HA:8_8:latest)',
      ref: { publisher:'RedHat', offer:'RHEL-HA', sku:'8_8', version:'latest' } },      

    { key: 'rhel_raw_9_raw_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'RHEL Raw 9 (Gen2) (RedHat:rhel-raw:9-raw-gen2:latest)',
      ref: { publisher:'RedHat', offer:'rhel-raw', sku:'9-raw-gen2', version:'latest' } },

    { key: 'rhel_raw_9_raw_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: true, scsiCapable: true,
      label: 'RHEL Raw 9 (Gen1) (RedHat:rhel-raw:9-raw:latest)',
      ref: { publisher:'RedHat', offer:'rhel-raw', sku:'9-raw', version:'latest' } },

    { key: 'rhel_sap_ha_84sapha_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'RHEL SAP HA 8.4 (Gen2) (RedHat:RHEL-SAP-HA:84sapha-gen2:latest)',
      ref: { publisher:'RedHat', offer:'RHEL-SAP-HA', sku:'84sapha-gen2', version:'latest' } },

    { key: 'rhel_sap_ha_96sapha_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'RHEL SAP HA 9.6 (Gen2) (RedHat:RHEL-SAP-HA:96sapha-gen2:latest)',
      ref: { publisher:'RedHat', offer:'RHEL-SAP-HA', sku:'96sapha-gen2', version:'latest' } },

    // Debian
    { key: 'debian_11_11_x64_gen1_latest', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'Debian 11 x86_64 (Gen1) (Debian:debian-11:11:latest)',
      ref: { publisher:'Debian', offer:'debian-11', sku:'11', version:'latest' } },

    { key: 'debian_12_12_x64_gen1_latest', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'Debian 12 x86_64 (Gen1) (Debian:debian-12:12:latest)',
      ref: { publisher:'Debian', offer:'debian-12', sku:'12', version:'latest' } },
      
    { key: 'debian_13_13_x64_gen1_latest', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'Debian 13 x86_64 (Gen1) (Debian:debian-13:13:latest)',
      ref: { publisher:'Debian', offer:'debian-13', sku:'13', version:'latest' } },      

    { key: 'debian_11_11_gen2_x64_gen2_latest', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'Debian 11 x86_64 (Gen2) (Debian:debian-11:11-gen2:latest)',
      ref: { publisher:'Debian', offer:'debian-11', sku:'11-gen2', version:'latest' } },

    { key: 'debian_12_12_gen2_x64_gen2_latest', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'Debian 12 x86_64 (Gen2) (Debian:debian-12:12-gen2:latest)',
      ref: { publisher:'Debian', offer:'debian-12', sku:'12-gen2', version:'latest' } },
      
    { key: 'debian_13_13_gen2_x64_gen2_latest', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'Debian 13 x86_64 (Gen2) (Debian:debian-13:13-gen2:latest)',
      ref: { publisher:'Debian', offer:'debian-13', sku:'13-gen2', version:'latest' } },      

    { key: 'debian_12_12_arm64_arm64_gen2_latest', arch: 'Arm64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'Debian 12 Arm64 (Gen2) (Debian:debian-12:12-arm64:latest)',
      ref: { publisher:'Debian', offer:'debian-12', sku:'12-arm64', version:'latest' } },

    { key: 'debian_13_13_arm64_arm64_gen2_latest', arch: 'Arm64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'Debian 13 Arm64 (Gen2) (Debian:debian-13:13-arm64:latest)',
      ref: { publisher:'Debian', offer:'debian-13', sku:'13-arm64', version:'latest' } },      
    
    // Canonical
    { key: 'ubuntu_24_04_lts_server_arm64_arm64_gen2', arch: 'Arm64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'Ubuntu 24.04 Arm64 (Gen2) (Canonical:ubuntu-24_04-lts:server-arm64:latest)',
      ref: { publisher:'Canonical', offer:'ubuntu-24_04-lts', sku:'server-arm64', version:'latest' } },

    { key: 'ubuntu_24_04_lts_server_gen1_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'Ubuntu 24.04 (Gen1) (Canonical:ubuntu-24_04-lts:server-gen1:latest)',
      ref: { publisher:'Canonical', offer:'ubuntu-24_04-lts', sku:'server-gen1', version:'latest' } },

    { key: 'ubuntu_24_04_lts_server_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'Ubuntu 24.04 (Gen2) (Canonical:ubuntu-24_04-lts:server:latest)',
      ref: { publisher:'Canonical', offer:'ubuntu-24_04-lts', sku:'server', version:'latest' } },

    // SUSE
    { key: 'sles_12_sp5_gen2_x64_gen2_latest', arch: 'x64', gen: 'Gen2', nvmeCapable: false, scsiCapable: true,
      label: 'SLES 12 SP5 x86_64 (Gen2) (SUSE:sles-12-sp5:gen2:latest)',
      ref: { publisher:'SUSE', offer:'sles-12-sp5', sku:'gen2', version:'latest' } },

    { key: 'sles_15_sp6_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'SLES 15 SP6 x86_64(Gen2) (SUSE:sles-15-sp6:gen2:latest)',
      ref: { publisher:'SUSE', offer:'sles-15-sp6', sku:'gen2', version:'latest' } },

    { key: 'sles_15_sp7_gen1_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'SLES 15 SP7 x86_64 (Gen1) (SUSE:sles-15-sp7:gen1:latest)',
      ref: { publisher:'SUSE', offer:'sles-15-sp7', sku:'gen1', version:'latest' } },

    { key: 'sles_15_sp7_arm64_gen2_arm64_gen2', arch: 'Arm64', gen: 'Gen2', nvmeCapable: false, scsiCapable: true,
      label: 'SLES 15 SP7 Arm64 (Gen2) (SUSE:sles-15-sp7-arm64:gen2:latest)',
      ref: { publisher:'SUSE', offer:'sles-15-sp7-arm64', sku:'gen2', version:'latest' } },

    { key: 'sles_15_sp7_basic_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'SLES 15 SP7 basic x86_64 (Gen2) (SUSE:sles-15-sp7-basic:gen2:latest)',
      ref: { publisher:'SUSE', offer:'sles-15-sp7-basic', sku:'gen2', version:'latest' } },

    { key: 'sles_16_0_x86_64_gen1_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'SLES 16.0 x86_64 (Gen1) (SUSE:sles-16-0-x86-64:gen1:latest)',
      ref: { publisher:'SUSE', offer:'sles-16-0-x86-64', sku:'gen1', version:'latest' } },

    { key: 'sles_16_0_x86_64_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'SLES 16.0 x86_64 (Gen2) (SUSE:sles-16-0-x86-64:gen2:latest)',
      ref: { publisher:'SUSE', offer:'sles-16-0-x86-64', sku:'gen2', version:'latest' } },

    { key: 'sles_sap_15_sp7_gen1_x64_gen1', arch: 'x64', gen: 'Gen1', nvmeCapable: false, scsiCapable: true,
      label: 'SLES SAP 15 SP7 x86_64 (Gen1) (SUSE:sles-sap-15-sp7:gen1:latest)',
      ref: { publisher:'SUSE', offer:'sles-sap-15-sp7', sku:'gen1', version:'latest' } },

    { key: 'sles_sap_15_sp7_gen2_x64_gen2', arch: 'x64', gen: 'Gen2', nvmeCapable: true, scsiCapable: true,
      label: 'SLES SAP 15 SP7 x86_64 (Gen2) (SUSE:sles-sap-15-sp7:gen2:latest)',
      ref: { publisher:'SUSE', offer:'sles-sap-15-sp7', sku:'gen2', version:'latest' } },
];
