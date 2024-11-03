import crypto from 'crypto';

export function encrypt(key: Buffer, value: Buffer): Buffer {
  if (key.length !== 16) {
    throw new Error('Key length must be 16 bytes.');
  }
  const reversedKey = Buffer.from(key).reverse();
  const paddedValue = Buffer.concat([Buffer.from(value), Buffer.alloc(16 - value.length)]);
  const reversedValue = Buffer.from(paddedValue).reverse();

  const cipher = crypto.createCipheriv('aes-128-ecb', reversedKey, null);
  let encrypted = cipher.update(reversedValue);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  
  return Buffer.from(encrypted).reverse();
}

export function makeChecksum(key: Buffer, nonce: Buffer, payload: Buffer): Buffer {
  const base = Buffer.concat([nonce, Buffer.from([payload.length])]).subarray(0, 16);
  let check = encrypt(key, base);

  for (let i = 0; i < payload.length; i += 16) {
    const block = Buffer.concat([payload.subarray(i, i + 16), Buffer.alloc(16)]).subarray(0, 16);
    check = Buffer.from(check.map((byte, index) => byte ^ block[index]));
    check = encrypt(key, check);
  }

  return check;
}

export function cryptPayload(key: Buffer, nonce: Buffer, payload: Buffer): Buffer {
  const base = Buffer.concat([Buffer.from([0x00]), nonce]).subarray(0, 16);
  let result = Buffer.alloc(0);
  const baseBuffer = Buffer.from(base);

  for (let i = 0; i < payload.length; i += 16) {
    const encBase = encrypt(key, baseBuffer);
    const block = Buffer.from(payload.subarray(i, i + 16));
    const encryptedBlock = Buffer.from(encBase.map((byte, index) => byte ^ (block[index] || 0)));

    result = Buffer.concat([result, encryptedBlock]);
    baseBuffer[0] += 1;
  }

  return result;
}

export function makeCommandPacket(
  key: Buffer,
  address: string,
  destId: number,
  command: number,
  data: Buffer,
): Buffer {
  const sequence = crypto.randomBytes(3);
  const macBuffer = Buffer.from(address.split(':').reverse().join(''), 'hex');
  const nonce = Buffer.concat([macBuffer.slice(0, 4), Buffer.from([0x01]), sequence]);

  const dest = Buffer.alloc(2);
  dest.writeUInt16LE(destId, 0);
  const payload = Buffer.concat([
    dest,
    Buffer.from([command]),
    Buffer.from([0x60, 0x01]),
    data,
    Buffer.alloc(15 - data.length - 5),
  ]);

  const checksum = makeChecksum(key, nonce, payload);
  const encryptedPayload = cryptPayload(key, nonce, payload);
  
  return Buffer.concat([sequence, checksum.slice(0, 2), encryptedPayload]);
}

export function decryptPacket(key: Buffer, address: string, packet: Buffer): Buffer | null {
  const macBuffer = Buffer.from(address.split(':').reverse().join(''), 'hex');
  const nonce = Buffer.concat([macBuffer.subarray(0, 3), packet.slice(0, 5)]);

  const decryptedPayload = cryptPayload(key, nonce, packet.slice(7));
  const expectedChecksum = makeChecksum(key, nonce, decryptedPayload);

  if (!expectedChecksum.subarray(0, 2).equals(packet.slice(5, 7))) {
    return null;
  }

  return Buffer.concat([packet.subarray(0, 7), decryptedPayload]);
}

export function makePairPacket(meshName: Buffer, meshPassword: Buffer, sessionRandom: Buffer): Buffer {
  const paddedMeshName = Buffer.concat([meshName, Buffer.alloc(16 - meshName.length)]);
  const paddedMeshPassword = Buffer.concat([meshPassword, Buffer.alloc(16 - meshPassword.length)]);
  const paddedSessionRandom = Buffer.concat([sessionRandom, Buffer.alloc(16 - sessionRandom.length)]);

  const namePass = Buffer.from(paddedMeshName.map((byte, index) => byte ^ paddedMeshPassword[index]));
  const encryptedNamePass = encrypt(paddedSessionRandom, namePass);

  return Buffer.concat([Buffer.from([0x0c]), sessionRandom, encryptedNamePass.subarray(0, 8)]);
}

export function makeSessionKey(
  meshName: Buffer,
  meshPassword: Buffer,
  sessionRandom: Buffer,
  responseRandom: Buffer,
): Buffer {
  const random = Buffer.concat([sessionRandom, responseRandom]);
  const paddedMeshName = Buffer.concat([meshName, Buffer.alloc(16 - meshName.length)]);
  const paddedMeshPassword = Buffer.concat([meshPassword, Buffer.alloc(16 - meshPassword.length)]);

  const namePass = Buffer.from(paddedMeshName.map((byte, index) => byte ^ paddedMeshPassword[index]));
  return encrypt(namePass, random);
}

export function crc16(array: Buffer): number {
  const poly = [0x0, 0xa001];
  let crc = 0xffff;

  for (const val of array) {
    let byte = val;
    for (let i = 0; i < 8; i++) {
      const ind = (crc ^ byte) & 0x1;
      crc = (crc >> 1) ^ poly[ind];
      byte >>= 1;
    }
  }

  return crc;
}
