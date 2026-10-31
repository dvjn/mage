// AES-256-GCM sealing under a versioned key. A sealed value is bound to a context string,
// and opening refuses any value the key cannot authenticate.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Sealed {
  keyVersion: number;
  // IV, then auth tag, then ciphertext.
  data: Buffer;
}

export interface Cipher {
  seal(plaintext: Buffer, context: string): Sealed;
  open(sealed: Sealed, context: string): Buffer;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createCipher({ version, key }: { version: number; key: Buffer }): Cipher {
  if (key.length !== 32) throw new Error("the credential key must be 32 bytes");
  return {
    seal(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { keyVersion: version, data: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]) };
    },

    open({ keyVersion, data }, context) {
      if (keyVersion !== version) throw new Error(`no credential key of version ${keyVersion}`);
      if (data.length < IV_BYTES + TAG_BYTES) throw new Error("sealed credential is truncated");
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, IV_BYTES))
        .setAAD(Buffer.from(context))
        .setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(data.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    },
  };
}
