import * as crypto from 'crypto';
import * as argon2 from 'argon2';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB
    timeCost: 2,       // t = 2
    parallelism: 1,    // p = 1
    raw: false,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function generateRandomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function encryptAesGcm(plainText: string, base64Key: string): string {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptAesGcm(cipherText: string, base64Key: string): string {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes');
  }
  const parts = cipherText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted ciphertext format');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(dataHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateBase32Secret(length = 32): string {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += BASE32_ALPHABET[bytes[i] % BASE32_ALPHABET.length];
  }
  return result;
}

export function base32Decode(str: string): Buffer {
  const cleaned = str.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (let i = 0; i < cleaned.length; i++) {
    const val = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (val === -1) {
      throw new Error(`Invalid base32 char: ${cleaned[i]}`);
    }
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret: string, counterOffset = 0): string {
  const key = base32Decode(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / 30) + counterOffset;
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, '0');
}

export function verifyTotp(token: string, secret: string, window = 1): number | false {
  if (!token || token.length !== 6) return false;
  const epoch = Math.floor(Date.now() / 1000);
  const currentStep = Math.floor(epoch / 30);
  for (let i = -window; i <= window; i++) {
    const step = currentStep + i;
    if (generateTotp(secret, i) === token) {
      return step;
    }
  }
  return false;
}

// Pairing code alphabet excluding easily confused chars (0, O, 1, I)
const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generatePairingCode(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  }
  return code;
}

export function validatePinComplexity(pin: string, accountPhone?: string | null): { valid: boolean; reason?: string } {
  if (!/^\d{6}$/.test(pin)) {
    return { valid: false, reason: 'PIN must be exactly 6 digits.' };
  }

  // 1. All 6 digits identical: 111111, 222222, etc.
  if (/^(\d)\1{5}$/.test(pin)) {
    return { valid: false, reason: 'PIN cannot have all identical digits.' };
  }

  // 2. Sequential increasing or decreasing digits
  const sequentialInc = '0123456789';
  const sequentialDec = '9876543210';
  if (sequentialInc.includes(pin) || sequentialDec.includes(pin)) {
    return { valid: false, reason: 'PIN cannot be sequential digits.' };
  }

  // 3. Last 6 digits of account phone number
  if (accountPhone) {
    const digitsOnlyPhone = accountPhone.replace(/\D/g, '');
    if (digitsOnlyPhone.length >= 6) {
      const last6Phone = digitsOnlyPhone.slice(-6);
      if (pin === last6Phone) {
        return { valid: false, reason: 'PIN cannot match the last 6 digits of phone number.' };
      }
    }
  }

  return { valid: true };
}
