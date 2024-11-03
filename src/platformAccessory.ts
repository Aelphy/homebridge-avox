import noble from '@abandonware/noble';
import crypto from 'crypto';

import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { AvoxHomebridgePlatform } from './platform.js';

import * as PacketUtils from './packetutils';

export class AvoxPlatformAccessory {
  // Commands :

  //: Set mesh groups.
  //: Data : 3 bytes  
  static readonly C_MESH_GROUP = 0xd7;

  //: Set the mesh id. The light will still answer to the 0 mesh id. Calling the 
  //: command again replaces the previous mesh id.
  //: Data : the new mesh id, 2 bytes in little endian order
  static readonly C_MESH_ADDRESS = 0xe0;

  //:
  static readonly C_MESH_RESET = 0xe3;

  //: On/Off command. Data : one byte 0, 1
  static readonly C_POWER = 0xd0;

  //: Data : one byte
  static readonly C_LIGHT_MODE = 0x33;

  //: Data : one byte 0 to 6 
  static readonly C_PRESET = 0xc8;

  //: White temperature. one byte 0 to 0x7f
  static readonly C_WHITE_TEMPERATURE = 0xf0;

  //: one byte 1 to 0x7f 
  static readonly C_WHITE_BRIGHTNESS = 0xf1;

  //: 4 bytes : 0x4 red green blue
  static readonly C_COLOR = 0xe2;

  //: one byte : 0xa to 0x64 .... 
  static readonly C_COLOR_BRIGHTNESS = 0xf2; 

  //: Data 4 bytes : How long a color is displayed in a sequence in milliseconds as 
  //:   an integer in little endian order
  static readonly C_SEQUENCE_COLOR_DURATION = 0xf5; 

  //: Data 4 bytes : Duration of the fading between colors in a sequence, in 
  //:   milliseconds, as an integer in little endian order
  static readonly C_SEQUENCE_FADE_DURATION = 0xf6; 

  //: 7 bytes
  static readonly C_TIME = 0xe4;

  //: 10 bytes
  static readonly C_ALARMS = 0xe5;

  static readonly PAIR_CHAR_UUID = '00010203-0405-0607-0809-0a0b0c0d1914';
  static readonly COMMAND_CHAR_UUID = '00010203-0405-0607-0809-0a0b0c0d1912';
  static readonly STATUS_CHAR_UUID = '00010203-0405-0607-0809-0a0b0c0d1911';
  static readonly OTA_CHAR_UUID = '00010203-0405-0607-0809-0a0b0c0d1913';

  private peripheral: noble.Peripheral | null = null;
  private service: Service;
  private sessionRandom: Uint8Array;
  private sessionToken: Uint8Array;
  private commandCharacteristic: noble.Characteristic | null = null;
  private pairCharacteristic: noble.Characteristic | null = null;
  private statusCharacteristic: noble.Characteristic | null = null;
  private meshId: number;

  private avoxStates = {
    On: false,
    Brightness: 0x0a,
    ColorTemperature: 0,
  };

  constructor(
    private readonly platform: AvoxHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly deviceConfig: { name: string, macAddress: string, meshName: string, meshPassword: string },
  ) {
    this.service = this.accessory.getService(this.platform.api.hap.Service.Lightbulb)
      || this.accessory.addService(this.platform.api.hap.Service.Lightbulb);

    this.service.getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service.getCharacteristic(this.platform.api.hap.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this));

    this.service.getCharacteristic(this.platform.api.hap.Characteristic.ColorTemperature)
      .onSet(this.setColorTemperature.bind(this));

    this.sessionToken = new Uint8Array(8);
    this.sessionRandom = new Uint8Array(8);
    this.meshId = 0;

    noble.on('stateChange', this.handleStateChange.bind(this));
    noble.on('discover', this.handleDiscover.bind(this));
  }

  private async handleStateChange(state: string) {
    if (state === 'poweredOn') {
      this.platform.log('Bluetooth powered on. Starting scan...');
      await noble.startScanningAsync([], false);
    } else {
      await noble.stopScanningAsync();
    }
  }

  private handleDiscover(peripheral: noble.Peripheral) {
    if (peripheral.id === this.deviceConfig.macAddress) {
      this.platform.log(`Found Eglo device: ${this.platform.api.hap.Characteristic.Name}`);
      noble.stopScanningAsync();
      peripheral.connectAsync().then(() => this.setupDevice(peripheral));
    }
  }

  private async setupDevice(peripheral: noble.Peripheral) {
    try {
      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync([], []);
      const pairCharacteristic = characteristics.find(c => c.uuid === AvoxPlatformAccessory.PAIR_CHAR_UUID);
      const statusCharacteristic = characteristics.find(c => c.uuid === AvoxPlatformAccessory.STATUS_CHAR_UUID);
      const commandCharacteristic = characteristics.find(c => c.uuid === AvoxPlatformAccessory.COMMAND_CHAR_UUID);
      crypto.getRandomValues(this.sessionRandom);

      if (pairCharacteristic) {
        this.platform.log('Connected to light characteristic.');
        this.peripheral = peripheral;
        this.pairCharacteristic = pairCharacteristic;

        const message = PacketUtils.makePairPacket(
          Buffer.from(this.deviceConfig.meshName, 'utf-8'),
          Buffer.from(this.deviceConfig.meshPassword, 'utf-8'),
          Buffer.from(this.sessionRandom));
        pairCharacteristic.writeAsync(message, true);

        if (statusCharacteristic) {
          this.statusCharacteristic = statusCharacteristic;
          statusCharacteristic.writeAsync(Buffer.from([0x01]), false);
          const reply = await pairCharacteristic.readAsync();

          // Check if the device paired successfully
          if (reply[0] === 0x0d) {
            this.sessionToken = PacketUtils.makeSessionKey(
              Buffer.from(this.deviceConfig.meshName, 'utf-8'),
              Buffer.from(this.deviceConfig.meshPassword, 'utf-8'),
              Buffer.from(this.sessionRandom),
              Buffer.from(reply.subarray(1, 9)),
            );

            if (commandCharacteristic) {
              this.commandCharacteristic = commandCharacteristic;
            } else {
              this.platform.log.error('Failed to find command characteristic');
            }

            this.platform.log.info('Connected and authenticated.');
            return true;
          } else {
            if (reply[0] === 0x0e) {
              this.platform.log.error('Authentication error: Check mesh name and password.');
            } else {
              this.platform.log.error(`Unexpected pairing response: ${reply.toString('hex')}`);
            }
            return false;
          }
        } else {
          this.platform.log.error('Failed to find status characteristic');
          return false;
        }
      } else {
        this.platform.log.error('Failed to find pair characteristic');
        return false;
      }
    } catch (error) {
      this.platform.log.error('Error setting up device:', error);
      return false;
    }
  }

  private async setMeshId(meshId: number) {
    this.meshId = meshId;
    const data = new Uint8Array([(meshId & 0xff), (meshId >> 8) & 0xff]);
    this.writeCommand(AvoxPlatformAccessory.C_MESH_ADDRESS, Buffer.from(data));
  }

  private async writeCommand(
    command: number,
    data: Buffer,
  ) {
    if (this.commandCharacteristic) {
      const packet = PacketUtils.makeCommandPacket(
        Buffer.from(this.sessionToken),
        this.deviceConfig.macAddress,
        this.meshId,
        command,
        data);

      await this.commandCharacteristic.writeAsync(packet, true);
    } else {
      this.platform.log.error('Command characteristic is not set.');
    }
  }

  async setOn(value: CharacteristicValue) {
    this.avoxStates.On = value as boolean;

    this.platform.log.debug('Set Characteristic On ->', value);
  
    if (this.peripheral && this.peripheral.state === 'connected') {
      const data = new Uint8Array([0x64]);
      this.writeCommand(AvoxPlatformAccessory.C_COLOR_BRIGHTNESS, Buffer.from(data));
    } else {
      this.platform.log.warn('Device not connected, cannot set state.');
    }
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possible. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.
   * In this case, you may decide not to implement `onGet` handlers, which may speed up
   * the responsiveness of your device in the Home app.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getOn(): Promise<CharacteristicValue> {
    const isOn = this.avoxStates.On;

    this.platform.log.debug('Get Characteristic On ->', isOn);

    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    return isOn;
  }

  async setBrightness(value: CharacteristicValue) {
    this.avoxStates.Brightness = value as number;

    this.platform.log.debug('Set Characteristic Brightness -> ', value);

    if (this.peripheral && this.peripheral.state === 'connected') {
      const data = new Uint8Array([value as number]);
      this.writeCommand(AvoxPlatformAccessory.C_COLOR_BRIGHTNESS, Buffer.from(data));
    } else {
      this.platform.log.warn('Device not connected, cannot set brightness.');
    }
  }

  async setColorTemperature(value: CharacteristicValue) {
    this.avoxStates.ColorTemperature = value as number;

    this.platform.log.debug('Set Characteristic ColorTemperature -> ', value);

    if (this.peripheral && this.peripheral.state === 'connected') {
      const data = new Uint8Array([value as number]);
      this.writeCommand(AvoxPlatformAccessory.C_WHITE_TEMPERATURE, Buffer.from(data));
    } else {
      this.platform.log.warn('Device not connected, cannot set color temperature.');
    }
  }
}
