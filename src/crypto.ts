function base64Buffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function passwordKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const source = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: 100000, hash: "SHA-256" }, source, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

export async function decryptPrivateKey(encrypted: string, salt: string, password: string): Promise<string> {
  const combined = new Uint8Array(base64Buffer(encrypted));
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: combined.slice(0, 12) }, await passwordKey(password, new Uint8Array(base64Buffer(salt))), combined.slice(12));
  return new TextDecoder().decode(decrypted);
}

export async function decryptHybridData(encrypted: string, privateKeyBase64: string): Promise<string> {
  const combined = new Uint8Array(base64Buffer(encrypted));
  const keyLength = (combined[0] << 8) | combined[1];
  const encryptedKey = combined.slice(2, 2 + keyLength);
  const iv = combined.slice(2 + keyLength, 2 + keyLength + 12);
  const payload = combined.slice(2 + keyLength + 12);
  const privateKey = await crypto.subtle.importKey("pkcs8", base64Buffer(privateKeyBase64), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  const rawAES = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, encryptedKey);
  const aes = await crypto.subtle.importKey("raw", rawAES, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aes, payload));
}
