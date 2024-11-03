import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import noble from '@abandonware/noble';

import { AvoxPlatformAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class AvoxHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    const devices = this.config.devices || [];
    devices.forEach((deviceConfig: { name: string, macAddress: string }) => {
      this.registerDevice(deviceConfig);
    });
  }

  registerDevice(deviceConfig: { name: string, macAddress: string }) {
    const uuid = this.api.hap.uuid.generate(deviceConfig.macAddress);
    const existingAccessory = this.accessories.get(uuid);

    const deviceContext = {
      ...deviceConfig,
      meshName: this.config.meshName,
      meshPassword: this.config.meshPassword,
    };

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      new AvoxPlatformAccessory(this, existingAccessory, deviceContext);
    } else {
      this.log.info('Adding new accessory:', deviceConfig.name);
      const accessory = new this.api.platformAccessory(deviceConfig.name, uuid);
      accessory.context.deviceConfig = deviceContext;
      new AvoxPlatformAccessory(this, accessory, deviceContext);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }
  }
}
