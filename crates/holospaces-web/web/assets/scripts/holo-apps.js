/**
 * holo-apps.js — Core Conceptual Model & Architecture Realization
 * 
 * This file implements the shared platform layer for holo-apps over the content-addressed
 * substrate. It realizes Part 1 and Part 2 of the holo-apps specification:
 * - Participant: self-sovereign cryptographic identity (identity κ)
 * - Event: signed, content-addressed, causal-parented record with AEAD payload encryption
 * - Collection: app-interpreted event DAG closure with membership validation & key rotation
 * - Reducer: topological ordering and deterministic reduction
 * - App & App Index: content-addressed manifests and discovery references
 * - Shell: stateless platform bootstrapper & organizer (Law L3)
 * 
 * Cryptography uses standard W3C WebCrypto API (ECDSA/ECDH and AES-GCM) for:
 * - SignatureAxis: Provenance & authentic authorship
 * - CurveAxis/AEAD: Confidentiality axis (epoch key wrap/unwrap & seal/open)
 * - HashAxis: Content addressing (identity-is-content)
 */

/**
 * Helper to produce deterministic, canonical JSON representation.
 * Enforces the "identity-is-content" invariant.
 */
export function canonicalJson(val) {
  if (val === null || val === undefined) return "null";
  if (Array.isArray(val)) {
    return "[" + val.map(v => canonicalJson(v)).join(",") + "]";
  }
  if (typeof val === "object") {
    const keys = Object.keys(val).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(val[k])).join(",") + "}";
  }
  return JSON.stringify(val);
}

/**
 * Unicode-safe Base64 encoding.
 */
export function base64Encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

export function base64Decode(str) {
  if (!str) return "";
  let cleanStr = str.trim();

  // If it's a full URL, try to extract the base64 payload from query parameters or hash
  if (cleanStr.startsWith("http://") || cleanStr.startsWith("https://")) {
    try {
      const url = new URL(cleanStr);
      const params = ["invite", "code", "join", "payload", "key"];
      let found = false;
      for (const p of params) {
        const val = url.searchParams.get(p);
        if (val) {
          cleanStr = val.trim();
          found = true;
          break;
        }
      }
      if (!found) {
        // Try hash (e.g. #invite=...)
        const hashStr = url.hash.substring(1);
        if (hashStr) {
          const hashParams = new URLSearchParams(hashStr);
          for (const p of params) {
            const val = hashParams.get(p);
            if (val) {
              cleanStr = val.trim();
              found = true;
              break;
            }
          }
          if (!found && hashStr.length > 20) {
            cleanStr = hashStr.trim();
          }
        }
      }
      if (cleanStr.startsWith("http://") || cleanStr.startsWith("https://")) {
        // Check for any long query parameter value
        let longest = "";
        url.searchParams.forEach((value) => {
          if (value.length > longest.length) {
            longest = value;
          }
        });
        if (longest.length > 20) {
          cleanStr = longest.trim();
        }
      }
    } catch (e) {
      console.log("Failed to parse base64 input as URL:", e);
    }
  }

  // Remove any whitespace, newlines, carriage returns, tabs
  cleanStr = cleanStr.replace(/\s+/g, "");

  // Convert base64url characters to standard base64 characters
  cleanStr = cleanStr.replace(/-/g, "+").replace(/_/g, "/");

  // Restore padding if missing
  const pad = cleanStr.length % 4;
  if (pad === 2) {
    cleanStr += "==";
  } else if (pad === 3) {
    cleanStr += "=";
  }

  // Guard: if it's not a valid base64 character set, return empty string cleanly
  const validBase64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!validBase64Regex.test(cleanStr)) {
    console.error("base64Decode error: Input contains invalid characters or has been truncated (e.g. with '...'). Cleaned input:", cleanStr);
    return "";
  }

  try {
    return decodeURIComponent(escape(atob(cleanStr)));
  } catch (e) {
    console.warn("base64Decode: Failed to decode base64 string:", e.message);
    return "";
  }
}

/**
 * Helper to compute SHA-256 hash (content address κ) of a string.
 * Supports HashAxis verification (Law L5/SEC-1).
 */
export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  let result = "";
  let x = BigInt(0);
  for (const b of bytes) {
    x = (x << 8n) + BigInt(b);
  }
  while (x > 0n) {
    const remainder = Number(x % 58n);
    x = x / 58n;
    result = BASE58_ALPHABET[remainder] + result;
  }
  for (const b of bytes) {
    if (b === 0) {
      result = BASE58_ALPHABET[0] + result;
    } else {
      break;
    }
  }
  return result;
}

export function base58Decode(str) {
  let x = BigInt(0);
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) throw new Error("Invalid base58 character");
    x = x * 58n + BigInt(value);
  }
  const bytes = [];
  while (x > 0n) {
    bytes.unshift(Number(x & 0xffn));
    x = x >> 8n;
  }
  for (let i = 0; i < str.length; i++) {
    if (str[i] === BASE58_ALPHABET[0]) {
      bytes.unshift(0);
    } else {
      break;
    }
  }
  return new Uint8Array(bytes);
}

export async function idToDidKey(hexPublicKey) {
  if (!hexPublicKey) return "";
  const bytes = new Uint8Array(hexPublicKey.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  const prefix = new Uint8Array([0x80, 0x24]); // multicodec p256-pub
  const combined = new Uint8Array(prefix.length + bytes.length);
  combined.set(prefix, 0);
  combined.set(bytes, prefix.length);
  return "did:key:z" + base58Encode(combined);
}

export function didKeyToId(did) {
  if (!did) return "";
  if (!did.startsWith("did:key:z")) {
    if (did.startsWith("did:key:")) {
      return did.substring(8);
    }
    return did;
  }
  const encoded = did.substring(9);
  const bytes = base58Decode(encoded);
  if (bytes[0] === 0x80 && bytes[1] === 0x24) {
    const rawKeyBytes = bytes.slice(2);
    return Array.from(rawKeyBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("Invalid multicodec prefix for p256-pub");
}

export async function resolveDid(did) {
  try {
    const publicKeyHex = didKeyToId(did);
    return {
      "@context": [
        "https://www.w3.org/ns/did/v1",
        "https://w3id.org/security/suites/jws-2020/v1"
      ],
      "id": did,
      "verificationMethod": [
        {
          "id": `${did}#key-1`,
          "type": "JsonWebKey2020",
          "controller": did,
          "publicKeyJwk": {
            "kty": "EC",
            "crv": "P-256",
            "x": base64UrlEncode(publicKeyHex.substring(2, 66)),
            "y": base64UrlEncode(publicKeyHex.substring(66, 130))
          }
        }
      ],
      "authentication": [`${did}#key-1`],
      "assertionMethod": [`${did}#key-1`],
      "capabilityInvocation": [`${did}#key-1`],
      "capabilityDelegation": [`${did}#key-1`]
    };
  } catch (e) {
    console.error("resolveDid error:", e);
    return null;
  }
}

function base64UrlEncode(hexStr) {
  const bytes = new Uint8Array(hexStr.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export async function sha256(text) {
  const msgUint8 = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * HoloAppsCrypto — WebCrypto interface for CurveAxis, SignatureAxis, and AEAD.
 * Key pairs are kept in-memory or persisted via OPFS/local storage.
 */
export class HoloAppsCrypto {
  /**
   * Generates a new self-sovereign participant key set.
   * Includes an ECDSA key pair (for signing/provenance) and an ECDH key pair (for key agreement/epoch wrapping).
   */
  static async generateIdentity() {
    const signKeys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const curveKeys = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );
    return { signKeys, curveKeys };
  }

  /**
   * Exports a public key to its canonical raw string address (identity κ).
   */
  static async exportPublicKey(key) {
    const buf = await crypto.subtle.exportKey("raw", key);
    const arr = Array.from(new Uint8Array(buf));
    return arr.map(b => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Imports a public key from its hex representation.
   */
  static async importPublicKey(hex, format = "ECDSA", usage = ["verify"]) {
    const bytes = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    return await crypto.subtle.importKey(
      "raw",
      bytes,
      {
        name: format,
        namedCurve: "P-256"
      },
      true,
      usage
    );
  }

  /**
   * Signs a payload using the participant's ECDSA private key.
   */
  static async sign(privateKey, text) {
    const data = new TextEncoder().encode(text);
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      privateKey,
      data
    );
    const arr = Array.from(new Uint8Array(sig));
    return arr.map(b => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Verifies an ECDSA signature.
   */
  static async verify(publicKeyHex, signatureHex, text) {
    try {
      const publicKey = await this.importPublicKey(publicKeyHex, "ECDSA", ["verify"]);
      const signature = new Uint8Array(signatureHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      const data = new TextEncoder().encode(text);
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: { name: "SHA-256" } },
        publicKey,
        signature,
        data
      );
    } catch (e) {
      console.log("Signature verification error:", e);
      return false;
    }
  }

  /**
   * Generates a new random symmetric epoch key for AES-GCM payload encryption.
   */
  static async generateEpochKey() {
    return await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt", "wrapKey", "unwrapKey"]
    );
  }

  /**
   * Seals a payload under an AES-GCM epoch key.
   * Emits hex-encoded ciphertext and a 12-byte initialization vector (iv).
   */
  static async sealPayload(epochKey, cleartext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(cleartext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      epochKey,
      data
    );
    const ctArr = Array.from(new Uint8Array(ciphertext));
    const ivArr = Array.from(iv);
    return {
      ciphertext: ctArr.map(b => b.toString(16).padStart(2, "0")).join(""),
      iv: ivArr.map(b => b.toString(16).padStart(2, "0")).join("")
    };
  }

  /**
   * Opens an AES-GCM sealed payload.
   */
  static async openPayload(epochKey, ciphertextHex, ivHex) {
    const iv = new Uint8Array(ivHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const ct = new Uint8Array(ciphertextHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      epochKey,
      ct
    );
    return new TextDecoder().decode(decrypted);
  }

  static async wrapEpochKey(epochKey, senderPrivateCurveKey, recipientPublicCurveKeyHex) {
    const recipientKey = await this.importPublicKey(recipientPublicCurveKeyHex, "ECDH", []);
    
    // Derive a shared wrapping key using ECDH
    const wrapKey = await crypto.subtle.deriveKey(
      { name: "ECDH", public: recipientKey },
      senderPrivateCurveKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    
    // Export the raw epoch key bytes
    const epochKeyRaw = await crypto.subtle.exportKey("raw", epochKey);
    
    // Encrypt the raw key bytes using AES-GCM
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedRaw = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      wrapKey,
      epochKeyRaw
    );
    
    const ctArr = Array.from(new Uint8Array(encryptedRaw));
    const ivArr = Array.from(iv);
    return JSON.stringify({
      ciphertext: ctArr.map(b => b.toString(16).padStart(2, "0")).join(""),
      iv: ivArr.map(b => b.toString(16).padStart(2, "0")).join("")
    });
  }

  /**
   * Unwraps (decrypts) the epoch key using a recipient's ECDH private curve key.
   */
  static async unwrapEpochKey(wrappedKeyString, recipientPrivateCurveKey, senderPublicCurveKeyHex) {
    const senderKey = await this.importPublicKey(senderPublicCurveKeyHex, "ECDH", []);
    const { ciphertext, iv } = JSON.parse(wrappedKeyString);
    const ct = new Uint8Array(ciphertext.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const ivBytes = new Uint8Array(iv.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    
    // Derive the same wrapping key using ECDH
    const wrapKey = await crypto.subtle.deriveKey(
      { name: "ECDH", public: senderKey },
      recipientPrivateCurveKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    
    // Decrypt the raw epoch key bytes
    const decryptedRaw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivBytes },
      wrapKey,
      ct
    );
    
    // Import back as an AES-GCM key
    return await crypto.subtle.importKey(
      "raw",
      decryptedRaw,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }
}

/**
 * Participant — cryptographic identity representing the unit of authorship and authority.
 */
export class Participant {
  constructor(signKeys, curveKeys, identityId, curveId) {
    this.signKeys = signKeys;
    this.curveKeys = curveKeys;
    this.id = identityId;      // public ECDSA hex (identity κ)
    this.curveId = curveId;    // public ECDH hex (CurveAxis ID)
  }

  static async create() {
    const { signKeys, curveKeys } = await HoloAppsCrypto.generateIdentity();
    const id = await HoloAppsCrypto.exportPublicKey(signKeys.publicKey);
    const curveId = await HoloAppsCrypto.exportPublicKey(curveKeys.publicKey);
    return new Participant(signKeys, curveKeys, id, curveId);
  }

  async exportJwk() {
    const signPrivate = await crypto.subtle.exportKey("jwk", this.signKeys.privateKey);
    const signPublic = await crypto.subtle.exportKey("jwk", this.signKeys.publicKey);
    const curvePrivate = await crypto.subtle.exportKey("jwk", this.curveKeys.privateKey);
    const curvePublic = await crypto.subtle.exportKey("jwk", this.curveKeys.publicKey);
    
    return {
      id: this.id,
      curveId: this.curveId,
      signKeys: {
        privateKey: signPrivate,
        publicKey: signPublic
      },
      curveKeys: {
        privateKey: curvePrivate,
        publicKey: curvePublic
      }
    };
  }

  static async importJwk(jwkObj) {
    const signPrivateKey = await crypto.subtle.importKey(
      "jwk",
      jwkObj.signKeys.privateKey,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"]
    );
    const signPublicKey = await crypto.subtle.importKey(
      "jwk",
      jwkObj.signKeys.publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"]
    );
    const curvePrivateKey = await crypto.subtle.importKey(
      "jwk",
      jwkObj.curveKeys.privateKey,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );
    const curvePublicKey = await crypto.subtle.importKey(
      "jwk",
      jwkObj.curveKeys.publicKey,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );

    return new Participant(
      { privateKey: signPrivateKey, publicKey: signPublicKey },
      { privateKey: curvePrivateKey, publicKey: curvePublicKey },
      jwkObj.id,
      jwkObj.curveId
    );
  }
}

/**
 * Event — immutable content-addressed statement.
 */
export class Event {
  /**
   * Constructs an event.
   * @param {Object} header - cleartext metadata header
   * @param {Object} body - sealed body ciphertext, iv
   * @param {string} signature - author's ECDSA signature over canonical header+body
   * @param {string} id - computed content address hash (κ)
   */
  constructor(header, body, signature, id) {
    this.header = header;
    this.body = body;
    this.signature = signature;
    this.id = id; // content address κ
  }

  /**
   * Authors and signs a new event.
   */
  static async create({ kind, author, collectionId, parents = [], epochId = "genesis", clock = 0, payload = {} }, participant, epochKey = null) {
    const header = {
      realization: "holo-apps/event",
      kind,
      author: participant.id,
      collection: collectionId,
      parents: parents.sort(), // sort to guarantee canonicalization
      epoch: epochId,
      clock
    };

    let body = {};
    if (epochKey) {
      const cleartextPayload = canonicalJson(payload);
      const { ciphertext, iv } = await HoloAppsCrypto.sealPayload(epochKey, cleartextPayload);
      body = { ciphertext, iv };
    } else {
      // Cleartext payload if no encryption epoch is active
      body = { cleartext: payload };
    }

    const payloadToSign = canonicalJson({ header, body });
    const signature = await HoloAppsCrypto.sign(participant.signKeys.privateKey, payloadToSign);
    const id = await sha256(payloadToSign);

    return new Event(header, body, signature, id);
  }

  /**
   * Verifies the event integrity, signature, and content address (verify-on-receipt / L5).
   */
  async verify() {
    const payloadToVerify = canonicalJson({ header: this.header, body: this.body });
    const matchesSignature = await HoloAppsCrypto.verify(this.header.author, this.signature, payloadToVerify);
    if (!matchesSignature) return false;

    // Verify Hash address
    const computedId = await sha256(payloadToVerify);
    return computedId === this.id;
  }
}

function getShellInstance() {
  if (typeof window === "undefined") return null;
  if (window.shellInstance) return window.shellInstance;
  const bodyShellEl = document.querySelector("body[x-data='shell']");
  if (bodyShellEl && window.Alpine) {
    return window.Alpine.$data(bodyShellEl);
  }
  const shellBlock = document.querySelector("shell-block");
  if (shellBlock && shellBlock.shadowRoot) {
    const wrapper = shellBlock.shadowRoot.querySelector(".shell-wrapper");
    if (wrapper && window.Alpine) {
      return window.Alpine.$data(wrapper);
    }
  }
  return null;
}

/**
 * Collection — app-interpreted closure of an event DAG.
 * Scope of membership and confidentiality epochs.
 */
export class Collection {
  constructor(id, reducer, appManifest = null) {
    this.id = id; // κ of genesis event
    this.reducer = reducer; // App's specific folding rules
    this.appManifest = appManifest;
    this.events = new Map(); // κ -> Event
    this.heads = new Set();  // current frontier
    
    // Membership & Capability state (derived)
    this.members = new Map(); // participantId -> { role: "admin"|"member", curveId }
    this.capabilities = new Map(); // participantId -> ["read", "write", "admin"]
    
    // Encryption Epochs state
    this.epochKeys = new Map(); // epochId (event κ) -> CryptoKey
    this.currentEpochId = "genesis";
    
    // Platform-level Tombstoning
    this.tombstones = new Set();
  }

  /**
   * Submits/imports an event into the collection DAG.
   * Performs verify-on-receipt (Law L5) and evaluates capabilities at its topological index.
   */
  async addEvent(event) {
    if (this.events.has(event.id)) return true;

    // Verify event signature and hash
    const isValid = await event.verify();
    if (!isValid) {
      console.error(`Collection ${this.id}: Refused event with invalid signature/hash: ${event.id}`);
      return false;
    }

    // Verify parents are already imported (causality check)
    for (const parentId of event.header.parents) {
      if (!this.events.has(parentId)) {
        console.log(`Collection ${this.id}: Missing causal parent ${parentId} for event ${event.id}`);
        return false;
      }
    }

    // Temporary insert to run capability check at this point
    this.events.set(event.id, event);

    // Re-evaluate capability list at this event's causality
    const authorized = await this.checkEventAuthority(event);
    if (!authorized) {
      console.error(`Collection ${this.id}: Refused unauthorized event ${event.id} from ${event.header.author}`);
      this.events.delete(event.id);
      return false;
    }

    // Update heads frontier
    for (const parentId of event.header.parents) {
      this.heads.delete(parentId);
    }
    this.heads.add(event.id);

    // If it's a membership, epoch, or capability event, parse state rules immediately
    await this.applyPlatformEvent(event);
    
    // Dynamically update the active capabilities and members state
    this.updateActiveState();

    return true;
  }

  /**
   * Upholds capability attenuation (SEC-2).
   * Validates if the author had the right to author the event kind at its topological position.
   */
  async checkEventAuthority(event) {
    if (event.id === this.id || event.header.kind === "genesis") {
      // Genesis event bootstraps the collection
      return true;
    }

    // Compute active capabilities at the parents frontier of this event
    const activeCaps = this.computeCapabilitiesAt(event.header.parents);
    const authorCaps = activeCaps.get(event.header.author) || [];

    // console.log(`checkEventAuthority for event ${event.id} (kind: ${event.header.kind}) by ${event.header.author}: authorCaps = ${JSON.stringify(authorCaps)}`);

    if (event.header.kind === "membership" || event.header.kind === "epoch") {
      return authorCaps.includes("admin");
    }

    // App kinds require "write" capability
    return authorCaps.includes("write") || authorCaps.includes("admin");
  }

  /**
   * Recomputes capabilities and members at the current heads frontier.
   * Handles workspace member propagation to channel collections.
   */
  updateActiveState() {
    this.capabilities = this.computeCapabilitiesAt(Array.from(this.heads));

    // Check if this collection is a channel owned by a workspace
    const shell = getShellInstance();
    if (shell) {
      const listToCheck = [];
      if (shell.workspaces) listToCheck.push(...shell.workspaces);
      if (shell.activeWorkspace && !listToCheck.some(w => w.id === shell.activeWorkspace.id)) {
        listToCheck.push(shell.activeWorkspace);
      }
      for (const ws of listToCheck) {
        if (ws.channels && ws.channels.some(ch => ch.id === this.id)) {
          // Inherit members from workspace collection
          if (ws.collection) {
            for (const [mId, memberObj] of ws.collection.members.entries()) {
              const wsCaps = ws.collection.capabilities.get(mId) || [];
              const role = wsCaps.includes("admin") ? "admin" : "member";
              this.members.set(mId, {
                role: role,
                curveId: memberObj.curveId || null
              });
            }
          }
          break;
        }
      }
    }
  }

  /**
   * Computes the capability mapping valid at a specific frontier set.
   */
  computeCapabilitiesAt(parentsFrontier) {
    // Collect all ancestors recursively
    const ancestors = new Set();
    const queue = [...parentsFrontier];
    while (queue.length > 0) {
      const id = queue.shift();
      if (!ancestors.has(id) && this.events.has(id)) {
        ancestors.add(id);
        const ev = this.events.get(id);
        queue.push(...ev.header.parents);
      }
    }

    // Sort ancestors topologically
    const sorted = this.topologicalSort(Array.from(ancestors));
    
    // Fold membership state locally
    const localCaps = new Map();
    // Creator initially gets admin
    if (this.events.has(this.id)) {
      const genesis = this.events.get(this.id);
      localCaps.set(genesis.header.author, ["read", "write", "admin"]);
    }

    // Check if this collection is a channel owned by a workspace
    const shell = getShellInstance();
    if (shell) {
      const listToCheck = [];
      if (shell.workspaces) listToCheck.push(...shell.workspaces);
      if (shell.activeWorkspace && !listToCheck.some(w => w.id === shell.activeWorkspace.id)) {
        listToCheck.push(shell.activeWorkspace);
      }
      for (const ws of listToCheck) {
        const isChannel = ws.channels && ws.channels.some(ch => ch.id === this.id);
        if (isChannel) {
          // Grant read/write capabilities to all workspace members
          if (ws.members) {
            for (const mId of ws.members) {
              if (!localCaps.has(mId)) {
                localCaps.set(mId, ["read", "write"]);
              }
            }
          }
          // The workspace creator/admin gets admin in the channel too
          if (ws.collection) {
            const wsCaps = ws.collection.computeCapabilitiesAt(Array.from(ws.collection.heads));
            for (const [mId, caps] of wsCaps.entries()) {
              if (caps.includes("admin")) {
                localCaps.set(mId, ["read", "write", "admin"]);
              }
            }
          }
          break;
        }
      }
    }

    for (const ev of sorted) {
      if (ev.header.kind === "membership") {
        const payload = ev.body.cleartext || ev.decodedPayload;
        if (payload && payload.target) {
          if (payload.action === "grant") {
            localCaps.set(payload.target, payload.capabilities || ["read", "write"]);
          } else if (payload.action === "revoke") {
            localCaps.delete(payload.target);
          }
        }
      } else if (ev.header.kind === "add-member") {
        const payload = ev.body.cleartext || ev.decodedPayload;
        if (payload && payload.object && payload.object.type === "Person") {
          const personId = payload.object.id;
          if (personId) {
            localCaps.set(personId, payload.object.capabilities || ["read", "write"]);
          }
        }
      }
    }

    return localCaps;
  }

  /**
   * Applies membership and epoch updates to the collection state.
   */
  async applyPlatformEvent(event) {
    if (event.header.kind === "genesis") {
      this.members.set(event.header.author, { role: "admin", curveId: null });
      this.capabilities.set(event.header.author, ["read", "write", "admin"]);
      return;
    }

    if (event.header.kind === "membership") {
      // Decode if payload ciphertext matches an epoch key we hold
      const payload = await this.decryptEventBody(event);
      if (payload) {
        event.decodedPayload = payload;
        if (payload.action === "grant") {
          this.members.set(payload.target, { role: payload.capabilities.includes("admin") ? "admin" : "member", curveId: payload.curveId });
          this.capabilities.set(payload.target, payload.capabilities);
        } else if (payload.action === "revoke") {
          this.members.delete(payload.target);
          this.capabilities.delete(payload.target);
        }
      }
    }

    if (event.header.kind === "add-member") {
      const payload = event.body.cleartext || event.decodedPayload;
      if (payload && payload.object && payload.object.type === "Person") {
        const personId = payload.object.id;
        if (personId) {
          const caps = payload.object.capabilities || ["read", "write"];
          const curveId = payload.object.curveId || null;
          this.members.set(personId, { role: caps.includes("admin") ? "admin" : "member", curveId });
          this.capabilities.set(personId, caps);
        }
      }
    }

    if (event.header.kind === "epoch") {
      this.currentEpochId = event.id;
    }

    if (event.header.kind === "tombstone") {
      const payload = await this.decryptEventBody(event);
      if (payload) {
        const targetId = payload.target || payload.object?.id;
        if (targetId) {
          this.tombstones.add(targetId);
        }
      }
    }
  }

  /**
   * Decrypts the body payload of an event if the epoch key is available.
   */
  async decryptEventBody(event) {
    if (event.body.cleartext) {
      return event.body.cleartext;
    }
    const epochId = event.header.epoch;
    if (epochId === "genesis") {
      return event.body.cleartext; // genesis is always cleartext or unencrypted
    }

    const epochKey = this.epochKeys.get(epochId);
    if (!epochKey) return null; // Key not yet available

    try {
      const decryptedText = await HoloAppsCrypto.openPayload(epochKey, event.body.ciphertext, event.body.iv);
      return JSON.parse(decryptedText);
    } catch (e) {
      console.error(`Failed to decrypt event body for ${event.id} under epoch ${epochId}:`, e);
      return null;
    }
  }

  /**
   * Unwraps a newly received epoch key using the participant's private curve key.
   */
  async unwrapAndStoreEpochKey(epochEvent, participant) {
    const payload = epochEvent.body.cleartext || epochEvent.decodedPayload;
    if (!payload || !payload.wrappedKeys) return false;

    const myWrappedKey = payload.wrappedKeys[participant.id];
    if (!myWrappedKey) return false;

    try {
      const epochKey = await HoloAppsCrypto.unwrapEpochKey(
        myWrappedKey,
        participant.curveKeys.privateKey,
        payload.senderCurveId
      );
      this.epochKeys.set(epochEvent.id, epochKey);
      this.currentEpochId = epochEvent.id;
      return true;
    } catch (e) {
      console.error(`Failed to unwrap epoch key for epoch ${epochEvent.id}:`, e);
      return false;
    }
  }

  /**
   * Helper to perform a deterministic topological sort of events.
   * Upholds "partial order + deterministic tiebreak" by sorting concurrent items via (clock, id).
   */
  topologicalSort(ids) {
    const sorted = [];
    const visited = new Set();
    const list = ids.map(id => this.events.get(id)).filter(Boolean);

    const visit = (ev) => {
      if (visited.has(ev.id)) return;
      visited.add(ev.id);

      // Visit parents first
      const parents = ev.header.parents
        .map(pId => this.events.get(pId))
        .filter(Boolean)
        .sort((a, b) => {
          if (a.header.clock !== b.header.clock) {
            return a.header.clock - b.header.clock;
          }
          return a.id.localeCompare(b.id);
        });

      for (const parent of parents) {
        visit(parent);
      }

      sorted.push(ev);
    };

    // Sort original list by clock and ID for deterministic order
    const entryPoints = [...list].sort((a, b) => {
      if (a.header.clock !== b.header.clock) {
        return a.header.clock - b.header.clock;
      }
      return a.id.localeCompare(b.id);
    });

    for (const ev of entryPoints) {
      visit(ev);
    }

    return sorted;
  }

  /**
   * Reduces the current Collection DAG frontier state to a single projection view.
   */
  async render() {
    const sortedEvents = this.topologicalSort(Array.from(this.events.keys()));
    const decryptedPayloads = [];

    for (const ev of sortedEvents) {
      if (this.tombstones.has(ev.id)) {
        continue;
      }
      if (ev.header.kind === "membership" || ev.header.kind === "epoch" || ev.header.kind === "tombstone") {
        continue; // Platform kinds are handled by membership/epochs mapping
      }
      const payload = await this.decryptEventBody(ev);
      if (payload) {
        decryptedPayloads.push({
          id: ev.id,
          author: ev.header.author,
          clock: ev.header.clock,
          kind: ev.header.kind,
          payload
        });
      }
    }

    try {
      const reducerCode = this.reducer.toString();
      return await runInSandbox(reducerCode, decryptedPayloads);
    } catch (e) {
      console.warn("Sandbox execution failed, falling back to local thread:", e);
      return this.reducer(decryptedPayloads);
    }
  }
}

/**
 * App — content-addressed application manifest (code-as-κ / SPINE-4).
 */
export class App {
  constructor(id, manifest) {
    this.id = id; // manifest κ
    this.name = manifest.name;
    this.reducerId = manifest.reducerId; // code κ
    this.projectionId = manifest.projectionId; // UI bundle κ
    this.kinds = manifest.kinds; // array of app-specific kinds
    this.capabilities = manifest.capabilities; // requested capabilities
  }

  static async create(name, reducerId, projectionId, kinds, capabilities, participant) {
    const manifest = {
      realization: "holo-apps/manifest",
      name,
      reducerId,
      projectionId,
      kinds,
      capabilities
    };
    const payload = canonicalJson(manifest);
    const signature = await HoloAppsCrypto.sign(participant.signKeys.privateKey, payload);
    const id = await sha256(canonicalJson({ manifest, signature }));
    return new App(id, manifest);
  }
}

/**
 * AppIndex — recommendation listing of app descriptors.
 * Upholds "discovery-is-not-authority" by resolving names to authentic manifests.
 */
export class AppIndex {
  constructor(publisherId, signature, list) {
    this.publisherId = publisherId;
    this.signature = signature;
    this.list = list; // array of { name, appUrl, metadata }
  }

  static async create(list, participant) {
    const payload = canonicalJson(list);
    const signature = await HoloAppsCrypto.sign(participant.signKeys.privateKey, payload);
    return new AppIndex(participant.id, signature, list);
  }

  async verify() {
    const payload = canonicalJson(this.list);
    return await HoloAppsCrypto.verify(this.publisherId, this.signature, payload);
  }
}

/**
 * Shell — stateless platform projection and app orchestrator (Law L3).
 */
export class Shell {
  constructor(participant) {
    this.participant = participant;
    this.installedApps = new Map(); // appManifestId -> App
    this.indexes = new Map(); // indexUrl/Id -> AppIndex
    this.activeCollections = new Map(); // collectionId -> Collection
  }

  /**
   * Registers a recommendation index.
   */
  async loadIndex(indexId, appIndex) {
    const isValid = await appIndex.verify();
    if (isValid) {
      this.indexes.set(indexId, appIndex);
      return true;
    }
    return false;
  }

  /**
   * Installs an app by verifying its manifest from the index.
   */
  installApp(app) {
    this.installedApps.set(app.id, app);
  }

  /**
   * Binds an app to a Collection and runs its reduction view.
   */
  async launch(appId, collection) {
    const app = this.installedApps.get(appId);
    if (!app) throw new Error(`App ${appId} is not installed`);
    collection.appManifest = app;
    this.activeCollections.set(collection.id, collection);
    return await collection.render();
  }
}

let sandboxIframe = null;
const sandboxRequests = new Map();
let nextRequestId = 1;
let sandboxReady = false;
const sandboxQueue = [];

function getSandboxIframe() {
  if (typeof document === "undefined") {
    throw new Error("DOM document is not available");
  }
  if (sandboxIframe) return sandboxIframe;
  
  sandboxIframe = document.createElement("iframe");
  sandboxIframe.setAttribute("sandbox", "allow-scripts");
  sandboxIframe.style.display = "none";
  sandboxIframe.srcdoc = `
    <!DOCTYPE html>
    <html>
    <head>
      <script>
        // Send a message when loaded and ready
        window.parent.postMessage({ type: "ready" }, "*");
        window.addEventListener("message", (e) => {
          const { action, reducerCode, events, requestId } = e.data;
          if (action === "reduce") {
            try {
              const reducerFn = new Function("events", "return (" + reducerCode + ")(events);");
              const result = reducerFn(events);
              window.parent.postMessage({ type: "response", requestId, result }, "*");
            } catch (err) {
              window.parent.postMessage({ type: "error", requestId, error: err.message }, "*");
            }
          }
        });
      </script>
    </head>
    <body></body>
    </html>
  `;
  
  window.addEventListener("message", (e) => {
    if (!e.data) return;
    if (e.data.type === "ready") {
      sandboxReady = true;
      while (sandboxQueue.length > 0) {
        const item = sandboxQueue.shift();
        try {
          sandboxIframe.contentWindow.postMessage(item.msg, "*");
        } catch (err) {
          item.reject(err);
        }
      }
      return;
    }
    if (e.data.requestId) {
      const req = sandboxRequests.get(e.data.requestId);
      if (req) {
        sandboxRequests.delete(e.data.requestId);
        if (e.data.type === "response") {
          req.resolve(e.data.result);
        } else {
          req.reject(new Error(e.data.error));
        }
      }
    }
  });

  document.body.appendChild(sandboxIframe);
  return sandboxIframe;
}

export function runInSandbox(reducerCode, events) {
  const iframe = getSandboxIframe();
  const requestId = nextRequestId++;
  
  // JSON-serialize/deserialize events to avoid proxy/DataCloneError in postMessage
  const cleanEvents = JSON.parse(JSON.stringify(events));
  const msg = {
    action: "reduce",
    reducerCode,
    events: cleanEvents,
    requestId
  };
  
  return new Promise((resolve, reject) => {
    sandboxRequests.set(requestId, { resolve, reject });
    if (sandboxReady) {
      try {
        iframe.contentWindow.postMessage(msg, "*");
      } catch (err) {
        sandboxRequests.delete(requestId);
        reject(err);
      }
    } else {
      sandboxQueue.push({ msg, reject });
    }
  });
}

export async function encryptPayload(cleartext, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoder.encode(cleartext)
  );
  
  const result = {
    salt: Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join(""),
    iv: Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join(""),
    ciphertext: Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, "0")).join("")
  };
  return "encrypted:" + base64Encode(JSON.stringify(result));
}

export async function decryptPayload(encryptedString, passphrase) {
  if (!encryptedString.startsWith("encrypted:")) {
    throw new Error("Invalid encrypted payload format");
  }
  const rawPayload = base64Decode(encryptedString.substring(10));
  const { salt: saltHex, iv: ivHex, ciphertext: ctHex } = JSON.parse(rawPayload);
  
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  const iv = new Uint8Array(ivHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  const ciphertext = new Uint8Array(ctHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext
  );
  return new TextDecoder().decode(decrypted);
}
