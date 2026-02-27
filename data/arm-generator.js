// -----------------------------
// ARM Generator (pure transform from sanitized VM model -> ARM template object)
// -----------------------------
/**
   * Generates a complete ARM template JSON object from the current VM configurations
   * and optional storage settings.
   *
   * This is a pure function (no side effects) that transforms the sanitized VM model
   * into a deployable ARM template. It produces:
   *   - Shared network resources: NSG, VNet, subnet.
   *   - Per-VM resources: NICs, optional public IPs, and VM resources.
   *   - Optional storage resources (SMB/NFS): storage accounts, file shares,
   *     private endpoints, private DNS zones/links, and outputs.
   *   - Ultra/PremiumV2 handling: zonal placement and ultraSSDEnabled when applicable.
   *   - Custom data encoding (base64): payload is base64-encoded for ARM customData.
   *
   * @param {Array<Object>} vms - Array of sanitized VM model objects.
   * @param {Object} storageOptions - Storage configuration from state.storageOptions.
   * @returns {Object} A complete ARM template object ready for JSON.stringify().
   */
function generateArmTemplate(vms, storageOptions) {
    const imageMap = Object.fromEntries(imageOptions.map(o => [o.key, o.ref]));
    const locationExpr = "[resourceGroup().location]";

    // ── Shared Disk ARM Catalog ──────────────────────────────────────────
    // Build a local catalog of shared disks for ARM generation.
    // Unlike collectSharedDiskCatalog() (used for UI), this version adds
    // `armName` (deployment-safe resource name) and `requiresZonalPlacement`
    // (whether the disk resource needs an availability zone).
    // Each shared disk becomes a standalone Microsoft.Compute/disks resource
    // with maxShares=2, and each VM references it via createOption: "Attach".
    const sharedDiskCatalog = new Map();
    (vms || []).forEach((vm) => {
      (vm.disks || []).forEach((d) => {
        if (!d || !d.sharedEnabled || !d.sharedDiskId) return;
        if (!sharedDiskSupportedFor(vm)) return;
        const id = String(d.sharedDiskId || '').trim();
        if (!id) return;
        if (!sharedDiskCatalog.has(id)) {
          sharedDiskCatalog.set(id, {
            id,
            armName: sharedDiskArmName(id),
            sku: String(d.sku || 'StandardSSD_LRS'),
            sizeGB: Number(d.sizeGB || LIMITS.DEFAULT_DATA_DISK_GB),
            refs: []
          });
        }
        const entry = sharedDiskCatalog.get(id);
        if ((entry.refs || []).length < 2) {
          entry.refs.push({ vmName: vm.name, disk: d });
        }
      });
    });

    // Shared disks require zonal placement when:
    //   (a) the disk is attached to 2 VMs (both must be in the same zone), or
    //   (b) the disk SKU is UltraSSD_LRS or PremiumV2_LRS (always zonal).
    sharedDiskCatalog.forEach((entry) => {
      entry.requiresZonalPlacement = (entry.refs || []).length >= 2 || entry.sku === 'UltraSSD_LRS' || entry.sku === 'PremiumV2_LRS';
    });

    // Determine if the template needs the ultraAvailabilityZone parameter.
    // This is true if any VM has Ultra/PremiumV2 data disks OR any shared disk
    // requires zonal placement (multi-VM attachment or zonal SKU).
    const hasAnyZonalDataDiskRequirement =
      (vms || []).some(vm => (vm.disks || []).some(d => d && (d.sku === 'UltraSSD_LRS' || d.sku === 'PremiumV2_LRS')))
      || Array.from(sharedDiskCatalog.values()).some(entry => !!entry.requiresZonalPlacement);
    const storageCfg = normalizeStorageOptions(storageOptions);
    const includeSmb = !!storageCfg.smbEnabled;
    const includeNfs = !!storageCfg.nfsEnabled;
    const includeAnyFileStorage = includeSmb || includeNfs;
    const template = {
      "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      "contentVersion": "1.0.0.0",
      "parameters": {
        "adminUsername": { "type": "string", "defaultValue": "azureuser" },
        "adminPassword": { "type": "secureString" },
        "ultraAvailabilityZone": {
          "type": "string",
          "defaultValue": "1",
          "allowedValues": ["1", "2", "3"],
          "metadata": {
            "description": "Availability Zone used when UltraSSD_LRS or PremiumV2_LRS requires zonal placement."
          }
        }
      },
      "variables": {
        "vnetName": "labVnet",
        "subnetName": "default",
        "nsgName": "labNsg",
        "addressPrefix": "10.1.0.0/16",
        "subnetPrefix": "10.1.0.0/24"
      },
      "resources": [],
      "outputs": { "vmFqdns": { "type": "array", "value": [] } }
    };

    if (includeSmb) {
      template.parameters.smbShareName = {
        "type": "string",
        "defaultValue": storageCfg.smbShareName
      };
      template.variables.smbStorageAccountName = "[toLower(concat('smb', take(uniqueString(resourceGroup().id), 20)))]";
    }
    if (includeNfs) {
      template.parameters.nfsShareName = {
        "type": "string",
        "defaultValue": storageCfg.nfsShareName
      };
      template.variables.nfsStorageAccountName = "[toLower(concat('nfs', take(uniqueString(subscription().id, resourceGroup().id), 20)))]";
    }
    if (includeAnyFileStorage) {
      template.variables.privateDnsZoneName = "privatelink.file.core.windows.net";
    }

    if (!hasAnyZonalDataDiskRequirement) {
      delete template.parameters.ultraAvailabilityZone;
    }

    // Deterministic private IP plan:
    // - public mode: all VMs => 10.1.0.10, 10.1.0.11, ...
    const vmPrivateIpMap = new Map();
    let controlVmIndex = -1;
    let nextVmHostOctet = 10;
    (vms || []).forEach((vm, idx) => {
      const vmName = String((vm && vm.name) || '').trim();
      if (!vmName) return;
      vmPrivateIpMap.set(vmName, `10.1.0.${nextVmHostOctet}`);
      nextVmHostOctet += 1;
    });

    const hostsEntries = Array.from(vmPrivateIpMap.entries())
      .map(([name, ip]) => `${ip} ${name}`)
      .join('\n');

    const hostsSyncScript = hostsEntries
      ? `# arm-builder-hosts-sync\nif [ ! -e /etc/hosts ]; then\n  touch /etc/hosts 2>/dev/null || true\nfi\nif [ -w /etc/hosts ]; then\n  sed -i '/# arm-builder-hosts-start/,/# arm-builder-hosts-end/d' /etc/hosts 2>/dev/null || true\n  cat <<'ARM_BUILDER_HOSTS_EOF' >> /etc/hosts\n# arm-builder-hosts-start\n${hostsEntries}\n# arm-builder-hosts-end\nARM_BUILDER_HOSTS_EOF\nfi`
      : '';

    // ── Emit standalone Microsoft.Compute/disks resources for shared disks ──
    // Each shared disk becomes an independent managed disk with maxShares=2,
    // allowing up to 2 VMs to attach it simultaneously. VMs reference these
    // disks via createOption: "Attach" + managedDisk.id (see per-VM section below).
    // Zonal placement is conditional: required for Ultra/PremiumV2 SKUs or
    // when the disk is shared across 2 VMs (both must be in the same zone).
    sharedDiskCatalog.forEach((entry) => {
      const diskResource = {
        "type": "Microsoft.Compute/disks",
        "apiVersion": "2023-04-02",
        "name": entry.armName,
        "location": locationExpr,
        "sku": { "name": entry.sku },
        "properties": {
          "creationData": { "createOption": "Empty" },
          "diskSizeGB": entry.sizeGB,
          "maxShares": 2
        }
      };
      if (entry.requiresZonalPlacement) {
        diskResource.zones = ["[parameters('ultraAvailabilityZone')]"];
      }
      template.resources.push(diskResource);
    });

    // Build NSG security rules: default SSH + custom rules from Extra options
    const securityRules = [
      {
        "name": "inbound_ssh_azurecloud",
        "properties": {
          "access": "Allow",
          "protocol": "Tcp",
          "direction": "Inbound",
          "priority": 100,
          "sourceAddressPrefix": "AzureCloud",
          "sourcePortRange": "*",
          "destinationAddressPrefix": "*",
          "destinationPortRange": "22"
        }
      }
    ];
    (state.customNsgRules || []).forEach((rule, idx) => {
      const port = String(rule.port || '').trim();
      if (!port) return;
      securityRules.push({
        "name": `inbound_custom_${idx + 1}_${(rule.protocol || 'tcp').toLowerCase()}_${port.replace(/[^0-9-]/g, '')}`,
        "properties": {
          "access": "Allow",
          "protocol": rule.protocol || "Tcp",
          "direction": "Inbound",
          "priority": 200 + idx,
          "sourceAddressPrefix": rule.source || "AzureCloud",
          "sourcePortRange": "*",
          "destinationAddressPrefix": "*",
          "destinationPortRange": port
        }
      });
    });

    template.resources.push({
      "type": "Microsoft.Network/networkSecurityGroups",
      "apiVersion": "2024-05-01",
      "name": "[variables('nsgName')]",
      "location": locationExpr,
      "properties": {
        "securityRules": securityRules
      }
    });

    template.resources.push({
      "type": "Microsoft.Network/virtualNetworks",
      "apiVersion": "2024-05-01",
      "name": "[variables('vnetName')]",
      "location": locationExpr,
      "properties": { "addressSpace": { "addressPrefixes": ["[variables('addressPrefix')]"] } }
    });

    const subnetProperties = {
      "addressPrefix": "[variables('subnetPrefix')]",
      "networkSecurityGroup": { "id": "[resourceId('Microsoft.Network/networkSecurityGroups', variables('nsgName'))]" }
    };
    if (includeAnyFileStorage) {
      subnetProperties.privateEndpointNetworkPolicies = "Disabled";
      subnetProperties.serviceEndpoints = [
        { "service": "Microsoft.Storage" }
      ];
    }

    template.resources.push({
      "type": "Microsoft.Network/virtualNetworks/subnets",
      "apiVersion": "2024-05-01",
      "name": "[format('{0}/{1}', variables('vnetName'), variables('subnetName'))]",
      "dependsOn": [
        "[resourceId('Microsoft.Network/virtualNetworks', variables('vnetName'))]",
        "[resourceId('Microsoft.Network/networkSecurityGroups', variables('nsgName'))]"
      ],
      "properties": subnetProperties
    });

    if (includeAnyFileStorage) {
      template.resources.push({
        "type": "Microsoft.Network/privateDnsZones",
        "apiVersion": "2024-06-01",
        "name": "[variables('privateDnsZoneName')]",
        "location": "global"
      });

      template.resources.push({
        "type": "Microsoft.Network/privateDnsZones/virtualNetworkLinks",
        "apiVersion": "2024-06-01",
        "name": "[format('{0}/{1}', variables('privateDnsZoneName'), 'files-vnet-link')]",
        "location": "global",
        "dependsOn": [
          "[resourceId('Microsoft.Network/privateDnsZones', variables('privateDnsZoneName'))]",
          "[resourceId('Microsoft.Network/virtualNetworks', variables('vnetName'))]"
        ],
        "properties": {
          "registrationEnabled": false,
          "virtualNetwork": {
            "id": "[resourceId('Microsoft.Network/virtualNetworks', variables('vnetName'))]"
          }
        }
      });
    }

    if (includeSmb) {
      template.resources.push({
        "type": "Microsoft.Storage/storageAccounts",
        "apiVersion": "2023-05-01",
        "name": "[variables('smbStorageAccountName')]",
        "location": locationExpr,
        "sku": { "name": "Standard_LRS" },
        "kind": "StorageV2",
        "properties": {
          "supportsHttpsTrafficOnly": true,
          "minimumTlsVersion": "TLS1_2",
          "allowSharedKeyAccess": true,
          "allowBlobPublicAccess": false,
          "publicNetworkAccess": "Disabled"
        }
      });

      template.resources.push({
        "type": "Microsoft.Storage/storageAccounts/fileServices/shares",
        "apiVersion": "2023-05-01",
        "name": "[format('{0}/default/{1}', variables('smbStorageAccountName'), parameters('smbShareName'))]",
        "dependsOn": [
          "[resourceId('Microsoft.Storage/storageAccounts', variables('smbStorageAccountName'))]"
        ],
        "properties": {
          "enabledProtocols": "SMB",
          "shareQuota": 100,
          "accessTier": "TransactionOptimized"
        }
      });

      template.resources.push({
        "type": "Microsoft.Network/privateEndpoints",
        "apiVersion": "2024-05-01",
        "name": "smb-files-pe",
        "location": locationExpr,
        "dependsOn": [
          "[resourceId('Microsoft.Storage/storageAccounts', variables('smbStorageAccountName'))]",
          "[resourceId('Microsoft.Network/virtualNetworks/subnets', variables('vnetName'), variables('subnetName'))]"
        ],
        "properties": {
          "subnet": {
            "id": "[resourceId('Microsoft.Network/virtualNetworks/subnets', variables('vnetName'), variables('subnetName'))]"
          },
          "privateLinkServiceConnections": [
            {
              "name": "smb-files-connection",
              "properties": {
                "privateLinkServiceId": "[resourceId('Microsoft.Storage/storageAccounts', variables('smbStorageAccountName'))]",
                "groupIds": ["file"]
              }
            }
          ]
        }
      });

      template.resources.push({
        "type": "Microsoft.Network/privateEndpoints/privateDnsZoneGroups",
        "apiVersion": "2024-05-01",
        "name": "[format('{0}/{1}', 'smb-files-pe', 'default')]",
        "dependsOn": [
          "[resourceId('Microsoft.Network/privateEndpoints', 'smb-files-pe')]",
          "[resourceId('Microsoft.Network/privateDnsZones', variables('privateDnsZoneName'))]"
        ],
        "properties": {
          "privateDnsZoneConfigs": [
            {
              "name": "config",
              "properties": {
                "privateDnsZoneId": "[resourceId('Microsoft.Network/privateDnsZones', variables('privateDnsZoneName'))]"
              }
            }
          ]
        }
      });

      template.outputs.smbStorageAccountName = {
        "type": "string",
        "value": "[variables('smbStorageAccountName')]"
      };
      template.outputs.smbSharePath = {
        "type": "string",
        "value": "[format('\\\\{0}.file.core.windows.net\\{1}', variables('smbStorageAccountName'), parameters('smbShareName'))]"
      };
    }

    if (includeNfs) {
      template.resources.push({
        "type": "Microsoft.Storage/storageAccounts",
        "apiVersion": "2023-05-01",
        "name": "[variables('nfsStorageAccountName')]",
        "location": locationExpr,
        "sku": { "name": "Premium_LRS" },
        "kind": "FileStorage",
        "properties": {
          "supportsHttpsTrafficOnly": false,
          "allowBlobPublicAccess": false,
          "publicNetworkAccess": "Disabled"
        }
      });

      template.resources.push({
        "type": "Microsoft.Storage/storageAccounts/fileServices/shares",
        "apiVersion": "2023-05-01",
        "name": "[format('{0}/default/{1}', variables('nfsStorageAccountName'), parameters('nfsShareName'))]",
        "dependsOn": [
          "[resourceId('Microsoft.Storage/storageAccounts', variables('nfsStorageAccountName'))]"
        ],
        "properties": {
          "enabledProtocols": "NFS",
          "rootSquash": "NoRootSquash",
          "shareQuota": 100
        }
      });

      template.resources.push({
        "type": "Microsoft.Network/privateEndpoints",
        "apiVersion": "2024-05-01",
        "name": "nfs-files-pe",
        "location": locationExpr,
        "dependsOn": [
          "[resourceId('Microsoft.Storage/storageAccounts', variables('nfsStorageAccountName'))]",
          "[resourceId('Microsoft.Network/virtualNetworks/subnets', variables('vnetName'), variables('subnetName'))]"
        ],
        "properties": {
          "subnet": {
            "id": "[resourceId('Microsoft.Network/virtualNetworks/subnets', variables('vnetName'), variables('subnetName'))]"
          },
          "privateLinkServiceConnections": [
            {
              "name": "nfs-files-connection",
              "properties": {
                "privateLinkServiceId": "[resourceId('Microsoft.Storage/storageAccounts', variables('nfsStorageAccountName'))]",
                "groupIds": ["file"]
              }
            }
          ]
        }
      });

      template.resources.push({
        "type": "Microsoft.Network/privateEndpoints/privateDnsZoneGroups",
        "apiVersion": "2024-05-01",
        "name": "[format('{0}/{1}', 'nfs-files-pe', 'default')]",
        "dependsOn": [
          "[resourceId('Microsoft.Network/privateEndpoints', 'nfs-files-pe')]",
          "[resourceId('Microsoft.Network/privateDnsZones', variables('privateDnsZoneName'))]"
        ],
        "properties": {
          "privateDnsZoneConfigs": [
            {
              "name": "config",
              "properties": {
                "privateDnsZoneId": "[resourceId('Microsoft.Network/privateDnsZones', variables('privateDnsZoneName'))]"
              }
            }
          ]
        }
      });

      template.outputs.nfsStorageAccountName = {
        "type": "string",
        "value": "[variables('nfsStorageAccountName')]"
      };
      template.outputs.nfsSharePath = {
        "type": "string",
        "value": "[format('{0}.file.core.windows.net:/{0}/{1}', variables('nfsStorageAccountName'), parameters('nfsShareName'))]"
      };
    }

    vms.forEach(vm => {
      const vmName = vm.name;
      const nics = (vm.nics && vm.nics.length) ? vm.nics : [ defaultNic(0) ];
      const allowAccel = accelNetSupportedFor(vm);
      const hasUltraSsdDataDisk = (vm.disks || []).some(d => d && d.sku === 'UltraSSD_LRS');
      const hasPremiumV2DataDisk = (vm.disks || []).some(d => d && d.sku === 'PremiumV2_LRS');
      // A VM also requires zonal placement if any of its attached shared disks
      // are flagged requiresZonalPlacement (multi-VM attachment or zonal SKU).
      // This ensures the VM, its PIP, and the shared disk are all zone-aligned.
      const hasSharedDiskRequiringZone = (vm.disks || []).some(d => {
        const sharedId = String((d && d.sharedDiskId) || '').trim();
        if (!(d && d.sharedEnabled && sharedId)) return false;
        const entry = sharedDiskCatalog.get(sharedId);
        const isAttachedRef = !!(entry && (entry.refs || []).some(ref => ref.disk === d && ref.vmName === vm.name));
        return !!(entry && isAttachedRef && entry.requiresZonalPlacement);
      });
      const requiresZonalPlacement = hasUltraSsdDataDisk || hasPremiumV2DataDisk || hasSharedDiskRequiringZone;

      // Per NIC: optional PIP + NIC
      nics.forEach(nic => {
        const nicName = `${vmName}-${nic.name}`;
        const pipName = `${vmName}-${nic.name}-pip`;

        if (nic.publicIp) {
          const dnsLabel = `[concat('${vmName}-${nic.name}', uniqueString(resourceGroup().id))]`;
          const pipResource = {
            "type": "Microsoft.Network/publicIPAddresses",
            "apiVersion": "2024-05-01",
            "name": pipName,
            "location": locationExpr,
            "sku": { "name": "Standard" },
            "properties": {
              "publicIPAllocationMethod": "Static",
              "publicIPAddressVersion": "IPv4",
              "dnsSettings": { "domainNameLabel": dnsLabel }
            }
          };
          // Ultra/PremiumV2 data disks require zonal VM placement; keep PIP aligned.
          if (requiresZonalPlacement) pipResource.zones = ["[parameters('ultraAvailabilityZone')]"];
          template.resources.push(pipResource);
          template.outputs.vmFqdns.value.push(
            `[reference(resourceId('Microsoft.Network/publicIPAddresses', '${pipName}')).dnsSettings.fqdn]`
          );
        }

        const nicDepends = ["[resourceId('Microsoft.Network/virtualNetworks/subnets', variables('vnetName'), variables('subnetName'))]"];
        if (nic.publicIp) nicDepends.unshift(`[resourceId('Microsoft.Network/publicIPAddresses', '${pipName}')]`);

        const ipconfigProps = {
          "subnet": { "id": "[resourceId('Microsoft.Network/virtualNetworks/subnets', variables('vnetName'), variables('subnetName'))]" },
          "privateIPAllocationMethod": "Dynamic"
        };
        if (nic === nics[0]) {
          const assignedIp = vmPrivateIpMap.get(vmName);
          if (assignedIp) {
            ipconfigProps.privateIPAllocationMethod = "Static";
            ipconfigProps.privateIPAddress = assignedIp;
          }
        }
        if (nic.publicIp) ipconfigProps.publicIPAddress = { "id": `[resourceId('Microsoft.Network/publicIPAddresses', '${pipName}')]` };

        template.resources.push({
          "type": "Microsoft.Network/networkInterfaces",
          "apiVersion": "2024-05-01",
          "name": nicName,
          "location": locationExpr,
          "dependsOn": nicDepends,
          "properties": {
            "enableAcceleratedNetworking": allowAccel ? resolvedAccelForNic(vm, nic) : false,
            "ipConfigurations": [ { "name": "ipconfig1", "properties": ipconfigProps } ]
          }
        });
      });

      const vmNicRefs = nics.map((nic, idx) => ({
        "id": `[resourceId('Microsoft.Network/networkInterfaces', '${vmName}-${nic.name}')]`,
        "properties": { "primary": idx === 0 }
      }));

      const vmDepends = nics.map(nic => `[resourceId('Microsoft.Network/networkInterfaces', '${vmName}-${nic.name}')]`);
      const selectedImage = imageByKey(vm.imageKey);
      const selectedImageGen = selectedImage ? selectedImage.gen : vm.gen;
      const customDataRaw = String(vm.customData || '');
      const customDataWithHosts = hostsSyncScript
        ? (customDataRaw ? `${hostsSyncScript}\n\n${customDataRaw}` : hostsSyncScript)
        : customDataRaw;
      const encodedCustomData = encodeCustomDataForArm(customDataWithHosts, !!vm.rebootRequired);

      // Build ARM data disk entries.
      // Shared disks use createOption: "Attach" with a resourceId reference to the
      // standalone Microsoft.Compute/disks resource (and add it to vmDepends).
      // Normal disks use createOption: "Empty" with inline size and SKU.
      const vmDataDisks = (vm.disks || []).map((d, lun) => {
        const sharedId = String((d && d.sharedDiskId) || '').trim();
        const sharedEntry = (d && d.sharedEnabled && sharedId) ? sharedDiskCatalog.get(sharedId) : null;
        const isAttachedRef = !!(sharedEntry && (sharedEntry.refs || []).some(ref => ref.disk === d && ref.vmName === vm.name));
        if (sharedEntry && isAttachedRef) {
          // Shared disk: reference the pre-created managed disk resource.
          const diskRef = `[resourceId('Microsoft.Compute/disks', '${sharedEntry.armName}')]`;
          if (!vmDepends.includes(diskRef)) vmDepends.push(diskRef);
          return {
            "lun": lun,
            "createOption": "Attach",
            "managedDisk": { "id": diskRef }
          };
        }
        // Normal disk: create inline with the VM.
        return {
          "lun": lun,
          "createOption": "Empty",
          "diskSizeGB": d.sizeGB,
          "managedDisk": { "storageAccountType": d.sku }
        };
      });

      const storageProfile = {
        "imageReference": imageMap[vm.imageKey],
        "osDisk": { "createOption": "FromImage", "managedDisk": { "storageAccountType": "StandardSSD_LRS" } },
        "dataDisks": vmDataDisks
      };
      // diskControllerType is valid only for Generation 2 VM/image combinations.
      if (vm.diskControllerType && vm.gen === 'Gen2' && selectedImageGen === 'Gen2') {
        storageProfile.diskControllerType = vm.diskControllerType;
      }

      const osProfile = {
        "computerName": vmName,
        "adminUsername": "[parameters('adminUsername')]"
      };
      osProfile.adminPassword = "[parameters('adminPassword')]";
      if (encodedCustomData) osProfile.customData = encodedCustomData;

      const vmProperties = {
        "hardwareProfile": { "vmSize": vm.size },
        "storageProfile": storageProfile,
        "networkProfile": { "networkInterfaces": vmNicRefs },
        "osProfile": osProfile,
        "diagnosticsProfile": { "bootDiagnostics": { "enabled": true } }
      };
      if (hasUltraSsdDataDisk) {
        vmProperties.additionalCapabilities = { "ultraSSDEnabled": true };
      }

      const vmResource = {
        "type": "Microsoft.Compute/virtualMachines",
        "apiVersion": "2023-03-01",
        "name": vmName,
        "location": locationExpr,
        "dependsOn": vmDepends,
        "properties": vmProperties
      };
      // Ultra/PremiumV2 data disks require a zonal VM (1/2/3). Default to zone 1.
      if (requiresZonalPlacement) vmResource.zones = ["[parameters('ultraAvailabilityZone')]"];

      template.resources.push(vmResource);
    });

    return template;
  }
