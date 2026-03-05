import crypto from 'crypto';
import { WALLET } from '../../config/constants.js';

export class Encryption {
  constructor(password) {
    if (!password) {
      throw new Error('Encryption password is required');
    }
    // Validate password strength
    Encryption.validatePassword(password);
    this.password = password;
  }

  encrypt(plaintext) {
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(
      this.password,
      salt,
      WALLET.PBKDF2_ITERATIONS,
      WALLET.PBKDF2_KEYLEN,
      WALLET.PBKDF2_DIGEST
    );

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(WALLET.ENCRYPTION_ALGORITHM, key, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();

    return {
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      ciphertext: encrypted,
      authTag: authTag.toString('hex')
    };
  }

  decrypt(encryptedData) {
    // Validate encrypted data structure
    if (!encryptedData || typeof encryptedData !== 'object') {
      throw new Error('Invalid encrypted data: must be object');
    }
    
    const { salt, iv, ciphertext, authTag } = encryptedData;
    
    if (!salt || !iv || !ciphertext || !authTag) {
      throw new Error('Invalid encrypted data: missing required fields (salt, iv, ciphertext, authTag)');
    }
    
    // Validate hex format and expected lengths
    const hexPattern = /^[0-9a-fA-F]+$/;
    if (!hexPattern.test(salt) || !hexPattern.test(iv) || !hexPattern.test(ciphertext) || !hexPattern.test(authTag)) {
      throw new Error('Invalid encrypted data: fields must be hex strings');
    }
    
    // Validate field lengths (salt=32 bytes=64 hex chars, iv=16 bytes=32 hex chars, authTag=16 bytes=32 hex chars)
    if (salt.length !== 32 || iv.length !== 32 || authTag.length !== 32) {
      throw new Error('Invalid encrypted data: incorrect field lengths (salt/iv/authTag must be 32 hex chars)');
    }
    
    // Ciphertext length varies but must be at least 1 byte (2 hex chars)
    if (ciphertext.length < 2) {
      throw new Error('Invalid encrypted data: ciphertext too short');
    }
    
    const key = crypto.pbkdf2Sync(
      this.password,
      Buffer.from(salt, 'hex'),
      WALLET.PBKDF2_ITERATIONS,
      WALLET.PBKDF2_KEYLEN,
      WALLET.PBKDF2_DIGEST
    );

    const decipher = crypto.createDecipheriv(
      WALLET.ENCRYPTION_ALGORITHM,
      key,
      Buffer.from(iv, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  static validatePassword(password) {
    if (!password || typeof password !== 'string') {
      throw new Error('Password must be a non-empty string');
    }
    
    if (password.length < 12) {
      throw new Error('Password must be at least 12 characters');
    }
    
    return true;
  }
}
