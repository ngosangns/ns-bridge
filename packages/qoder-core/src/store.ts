// ABOUTME: Decrypts the qodercli credential store with Qoder's own auth WASM.
// The store at `~/.qoder/.auth/user` is base64url(iv[16] || tag[16] || AES-256-GCM
// ciphertext), keyed by the first 16 chars of `~/.qoder/.auth/machine_id`. The
// cipher lives in a wasm-bindgen module embedded in qodercli; the asset is
// vendored here so the bridge reads tokens without shelling out to the CLI.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const nodeRequire = createRequire(import.meta.url);

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

type RetptrFn = (retptr: number, a: number, la: number, b: number, lb: number) => void;

/** Minimal wasm surface; the repo's lib set has no WebAssembly declarations. */
interface WasmMemory {
  readonly buffer: ArrayBuffer;
}

type QoderContextNew = (
  retptr: number,
  machinePtr: number,
  machineLen: number,
  versionPtr: number,
  versionLen: number,
  userPtr: number,
  userLen: number,
  extraPtr: number,
  extraLen: number,
) => void;

type QoderPrepareInfer = (
  retptr: number,
  ctx: number,
  endpointPtr: number,
  endpointLen: number,
  bodyPtr: number,
  bodyLen: number,
  modelPtr: number,
  modelLen: number,
  sourcePtr: number,
  sourceLen: number,
) => void;

interface QoderAuthExports {
  memory: WasmMemory;
  credential_storage_decrypt: RetptrFn;
  credential_storage_encrypt: RetptrFn;
  model_cache_decrypt: RetptrFn;
  qodercontext_new: QoderContextNew;
  qodercontext_prepareInferRequest: QoderPrepareInfer;
  requestresult_url: (retptr: number, result: number) => void;
  requestresult_body: (retptr: number, result: number) => void;
  requestresult_headers: (result: number) => number;
  __wbg_qodercontext_free: (ptr: number, drop: number) => void;
  __wbg_requestresult_free: (ptr: number, drop: number) => void;
  __wbindgen_export2: (size: number, align: number) => number;
  __wbindgen_export3: (ptr: number, oldLen: number, newLen: number, align: number) => number;
  __wbindgen_export4: (ptr: number, len: number, align: number) => void;
  __wbindgen_add_to_stack_pointer: (delta: number) => number;
}

const wasmGlobal = globalThis as unknown as {
  WebAssembly: {
    Module: new (bytes: Buffer) => object;
    Instance: new (module: object, imports: unknown) => { exports: Record<string, unknown> };
  };
};

// This wasm hardcodes externref 1024 as `undefined`. A 128-slot table makes
// signing clone that index and trap. qodercli 1.1.83 uses the same layout.
const HEAP_RESERVED = 1028;
const HEAP: unknown[] = new Array(1024).fill(undefined);
HEAP.push(undefined, null, true, false);
let heapNext = HEAP.length;

function addHeapObject(obj: unknown): number {
  if (heapNext === HEAP.length) HEAP.push(HEAP.length + 1);
  const idx = heapNext;
  heapNext = HEAP[idx] as number;
  HEAP[idx] = obj;
  return idx;
}

function takeObject(idx: number): unknown {
  const value = HEAP[idx];
  if (idx >= HEAP_RESERVED) {
    HEAP[idx] = heapNext;
    heapNext = idx;
  }
  return value;
}

function heapOrZero(value: unknown): number {
  return value === undefined || value === null ? 0 : addHeapObject(value);
}

let cached: QoderAuthExports | undefined;

function loadExports(): QoderAuthExports {
  if (cached) return cached;
  const bytes = readQoderAuthWasm();
  const module = new wasmGlobal.WebAssembly.Module(bytes);
  // Bound after instantiation; the closures only run on wasm calls, never
  // during the module's synchronous start.
  let exports: QoderAuthExports;
  const instance = new wasmGlobal.WebAssembly.Instance(module, {
    "./qoder_auth_wasm_bg.js": {
      __wbindgen_object_drop_ref(i: number): void {
        takeObject(i);
      },
      __wbindgen_object_clone_ref(i: number): number {
        return addHeapObject(HEAP[i]);
      },
      __wbg___wbindgen_throw_81fc77679af83bc6(p: number, l: number): void {
        throw new Error(DECODER.decode(new Uint8Array(exports.memory.buffer, p, l)));
      },
      __wbg___wbindgen_is_object_40c5a80572e8f9d3(i: number): number {
        const v = HEAP[i];
        return typeof v === "object" && v !== null ? 1 : 0;
      },
      __wbg___wbindgen_is_string_b29b5c5a8065ba1a(i: number): number {
        return typeof HEAP[i] === "string" ? 1 : 0;
      },
      __wbg___wbindgen_is_function_49868bde5eb1e745(i: number): number {
        return typeof HEAP[i] === "function" ? 1 : 0;
      },
      __wbg___wbindgen_is_undefined_c0cca72b82b86f4d(i: number): number {
        return HEAP[i] === undefined ? 1 : 0;
      },
      __wbg_Error_2e59b1b37a9a34c3(p: number, l: number): number {
        return addHeapObject(new Error(DECODER.decode(new Uint8Array(exports.memory.buffer, p, l))));
      },
      __wbg_set_08463b1df38a7e29(map: number, key: number, value: number): number {
        return addHeapObject((HEAP[map] as Map<unknown, unknown>).set(HEAP[key], HEAP[value]));
      },
      __wbg_getRandomValues_d49329ff89a07af1(ptr: number, len: number): void {
        globalThis.crypto.getRandomValues(new Uint8Array(exports.memory.buffer, ptr >>> 0, len >>> 0));
      },
      __wbg_getRandomValues_c44a50d8cfdaebeb(a: number, b: number): void {
        (HEAP[a] as { getRandomValues: (array: ArrayBufferView) => ArrayBufferView }).getRandomValues(
          HEAP[b] as ArrayBufferView,
        );
      },
      __wbg_crypto_38df2bab126b63dc(i: number): number {
        return addHeapObject((HEAP[i] as { crypto?: unknown }).crypto);
      },
      __wbg_process_44c7a14e11e9f69e(i: number): number {
        return addHeapObject((HEAP[i] as { process?: unknown }).process);
      },
      __wbg_versions_276b2795b1c6a219(i: number): number {
        return addHeapObject((HEAP[i] as { versions?: unknown }).versions);
      },
      __wbg_node_84ea875411254db1(i: number): number {
        return addHeapObject((HEAP[i] as { node?: unknown }).node);
      },
      __wbg_require_b4edbdcf3e2a1ef0(): number {
        return addHeapObject(nodeRequire);
      },
      __wbg_msCrypto_bd5a034af96bcba6(i: number): number {
        return addHeapObject((HEAP[i] as { msCrypto?: unknown }).msCrypto);
      },
      __wbg_randomFillSync_6c25eac9869eb53c(a: number, b: number): void {
        (HEAP[a] as { randomFillSync: (buffer: unknown) => unknown }).randomFillSync(takeObject(b));
      },
      __wbg_call_d578befcc3145dee(fn: number, recv: number, arg: number): number {
        return addHeapObject((HEAP[fn] as (this: unknown, arg: unknown) => unknown).call(HEAP[recv], HEAP[arg]));
      },
      __wbg_new_with_length_9cedd08484b73942(len: number): number {
        return addHeapObject(new Uint8Array(len >>> 0));
      },
      __wbg_length_0c32cb8543c8e4c8(i: number): number {
        return (HEAP[i] as { length: number }).length;
      },
      __wbg_prototypesetcall_3e05eb9545565046(ptr: number, len: number, src: number): void {
        Uint8Array.prototype.set.call(
          new Uint8Array(exports.memory.buffer, ptr >>> 0, len >>> 0),
          HEAP[src] as Uint8Array,
        );
      },
      __wbg_subarray_0f98d3fb634508ad(a: number, b: number, c: number): number {
        return addHeapObject((HEAP[a] as Uint8Array).subarray(b >>> 0, c >>> 0));
      },
      __wbg_new_99cabae501c0a8a0(): number {
        return addHeapObject(new Map());
      },
      __wbg_now_88621c9c9a4f3ffc(): number {
        return Date.now();
      },
      __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f(): number {
        return heapOrZero(globalThis);
      },
      __wbg_static_accessor_SELF_24f78b6d23f286ea(): number {
        return heapOrZero((globalThis as unknown as Record<string, unknown>).self);
      },
      __wbg_static_accessor_GLOBAL_f2e0f995a21329ff(): number {
        return heapOrZero((globalThis as unknown as Record<string, unknown>).global);
      },
      __wbg_static_accessor_WINDOW_59fd959c540fe405(): number {
        return heapOrZero((globalThis as unknown as Record<string, unknown>).window);
      },
      __wbindgen_cast_0000000000000001(ptr: number, len: number): number {
        return addHeapObject(new Uint8Array(exports.memory.buffer, ptr >>> 0, len >>> 0));
      },
      __wbindgen_cast_0000000000000002(ptr: number, len: number): number {
        return addHeapObject(DECODER.decode(new Uint8Array(exports.memory.buffer, ptr >>> 0, len >>> 0)));
      },
    },
  });
  exports = instance.exports as unknown as QoderAuthExports;
  for (const name of [
    "memory",
    "credential_storage_decrypt",
    "credential_storage_encrypt",
    "model_cache_decrypt",
    "qodercontext_new",
    "qodercontext_prepareInferRequest",
    "requestresult_url",
    "requestresult_body",
    "requestresult_headers",
    "__wbg_qodercontext_free",
    "__wbg_requestresult_free",
    "__wbindgen_export2",
    "__wbindgen_export3",
    "__wbindgen_export4",
    "__wbindgen_add_to_stack_pointer",
  ] as const) {
    if (!exports[name]) throw new Error(`qoder auth wasm is missing export ${name}`);
  }
  cached = exports;
  return exports;
}

/** The wasm ships next to every bundle: qoder-core/dist, cli/dist, and each host bundle. */
function readQoderAuthWasm(): Buffer {
  const override = process.env.NS_QODER_AUTH_WASM?.trim();
  if (override) return readFileSync(pathToFileURL(override));
  const here = new URL(".", import.meta.url);
  for (const relative of ["../vendor/qoder-auth.wasm", "./vendor/qoder-auth.wasm", "./qoder-auth.wasm"]) {
    const url = new URL(relative, here);
    const file = fileURLToPath(url);
    if (existsSync(file)) return readFileSync(file);
  }
  throw new Error("qoder auth wasm not found next to the bundle. Set NS_QODER_AUTH_WASM to the qoder-auth.wasm path.");
}

function passStringToWasm(exports: QoderAuthExports, str: string): [number, number] {
  const bytes = ENCODER.encode(str);
  const ptr = exports.__wbindgen_export2(bytes.length, 1) >>> 0;
  new Uint8Array(exports.memory.buffer).set(bytes, ptr);
  return [ptr, bytes.length];
}

/** Two-string wasm-bindgen export: `fn(&str, &str) -> Result<String, Error>` at a retptr. */
function callStringString(exports: QoderAuthExports, fn: RetptrFn, a: string, b: string): string {
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    const [pa, la] = passStringToWasm(exports, a);
    const [pb, lb] = passStringToWasm(exports, b);
    fn(retptr, pa, la, pb, lb);
    const view = new Int32Array(exports.memory.buffer, retptr, 4);
    const [ptr, len, errIdx, hasErr] = [view[0], view[1], view[2], view[3]];
    if (hasErr !== 0) throw takeObject(errIdx) as Error;
    return DECODER.decode(new Uint8Array(exports.memory.buffer, ptr, len));
  } finally {
    exports.__wbindgen_add_to_stack_pointer(16);
  }
}

export function decryptQoderStore(encrypted: string, key: string): string {
  return callStringString(loadExports(), loadExports().credential_storage_decrypt, encrypted, key);
}

export function encryptQoderStore(plain: string, key: string): string {
  return callStringString(loadExports(), loadExports().credential_storage_encrypt, plain, key);
}

/** Decrypt `<configDir>/.models/<uid>/catalog-v*`, which qodercli keys by uid. */
export function decryptQoderModelCache(encrypted: string, uid: string): string {
  return callStringString(loadExports(), loadExports().model_cache_decrypt, encrypted, uid);
}

/** Fields qodercli passes into `QoderContext` from the local session. */
const SIGNING_USER_FIELDS = [
  "uid",
  "encrypt_user_info",
  "key",
  "organization_id",
  "organization_tags",
  "data_policy_agreed",
] as const;

/** Same object qodercli's `zn()` sends as the fourth `QoderContext` argument. */
const QODER_SIGNING_EXTRAS = JSON.stringify({
  client_type: "5",
  business_product: "cli",
  business_type: "agent",
  scene: "assistant",
});

export interface QoderSigningIdentity {
  machineId: string;
  userInfoJson: string;
}

/** URL, headers, and body returned by `prepareInferRequest`. */
export interface QoderInferSignature {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function wasmResultString(
  exports: QoderAuthExports,
  fn: (retptr: number, handle: number) => void,
  handle: number,
): string | undefined {
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
  let ptr = 0;
  let len = 0;
  try {
    fn(retptr, handle);
    const view = new Int32Array(exports.memory.buffer, retptr, 4);
    ptr = view[0] ?? 0;
    len = view[1] ?? 0;
    if (ptr === 0) return undefined;
    return DECODER.decode(new Uint8Array(exports.memory.buffer, ptr, len));
  } finally {
    if (ptr !== 0) exports.__wbindgen_export4(ptr, len, 1);
    exports.__wbindgen_add_to_stack_pointer(16);
  }
}

function callContextNew(exports: QoderAuthExports, identity: QoderSigningIdentity, cosyVersion: string): number {
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    const [machinePtr, machineLen] = passStringToWasm(exports, identity.machineId);
    const [versionPtr, versionLen] = passStringToWasm(exports, cosyVersion);
    const [userPtr, userLen] = passStringToWasm(exports, identity.userInfoJson);
    const [extraPtr, extraLen] = passStringToWasm(exports, QODER_SIGNING_EXTRAS);
    exports.qodercontext_new(
      retptr,
      machinePtr,
      machineLen,
      versionPtr,
      versionLen,
      userPtr,
      userLen,
      extraPtr,
      extraLen,
    );
    const view = new Int32Array(exports.memory.buffer, retptr, 4);
    if ((view[2] ?? 0) !== 0) throw takeObject(view[1] ?? 0);
    return (view[0] ?? 0) >>> 0;
  } finally {
    exports.__wbindgen_add_to_stack_pointer(16);
  }
}

function callPrepareInfer(
  exports: QoderAuthExports,
  ctx: number,
  endpoint: string,
  bodyJson: string,
  modelKey: string,
  modelSource: string,
): number {
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    const [endpointPtr, endpointLen] = passStringToWasm(exports, endpoint);
    const [bodyPtr, bodyLen] = passStringToWasm(exports, bodyJson);
    const [modelPtr, modelLen] = passStringToWasm(exports, modelKey);
    const [sourcePtr, sourceLen] = passStringToWasm(exports, modelSource);
    exports.qodercontext_prepareInferRequest(
      retptr,
      ctx,
      endpointPtr,
      endpointLen,
      bodyPtr,
      bodyLen,
      modelPtr,
      modelLen,
      sourcePtr,
      sourceLen,
    );
    const view = new Int32Array(exports.memory.buffer, retptr, 4);
    if ((view[2] ?? 0) !== 0) throw takeObject(view[1] ?? 0);
    return (view[0] ?? 0) >>> 0;
  } finally {
    exports.__wbindgen_add_to_stack_pointer(16);
  }
}

function signatureHeaders(exports: QoderAuthExports, result: number): Record<string, string> {
  const headers: Record<string, string> = {};
  const value = takeObject(exports.requestresult_headers(result));
  if (!value || typeof (value as Map<unknown, unknown>).forEach !== "function") {
    throw new Error("qoder infer signer returned invalid headers");
  }
  (value as Map<unknown, unknown>).forEach((headerValue, name) => {
    headers[String(name)] = String(headerValue);
  });
  return headers;
}

/**
 * Sign one infer body the way qodercli's `prepareInferRequest` does.
 * The returned headers are part of the signature. Dropping them makes the
 * server answer `Signature invalid`.
 */
export function signQoderInferRequest(
  endpoint: string,
  bodyJson: string,
  modelKey: string,
  modelSource: string,
  identity: QoderSigningIdentity,
  cosyVersion: string,
): QoderInferSignature {
  const exports = loadExports();
  const ctx = callContextNew(exports, identity, cosyVersion);
  try {
    const result = callPrepareInfer(exports, ctx, endpoint, bodyJson, modelKey, modelSource);
    try {
      const url = wasmResultString(exports, exports.requestresult_url, result);
      const body = wasmResultString(exports, exports.requestresult_body, result);
      if (!url || body === undefined) throw new Error("qoder infer signer returned an empty request");
      return { url, headers: signatureHeaders(exports, result), body };
    } finally {
      exports.__wbg_requestresult_free(result, 0);
    }
  } finally {
    exports.__wbg_qodercontext_free(ctx, 0);
  }
}

export interface QoderStoredCredentials {
  accessToken?: string;
  securityOauthToken?: string;
  refreshToken?: string;
  expireTime?: number;
  refreshExpireTime?: number;
  uid?: string;
  email?: string;
}

function storedString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function storedNumber(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStoreRecord(configDir: string): { machineId: string; record: Record<string, unknown> } {
  const encrypted = readFileSync(`${configDir}/.auth/user`, "utf8");
  const machineId = readFileSync(`${configDir}/.auth/machine_id`, "utf8").trim();
  const plain = decryptQoderStore(encrypted, machineId.slice(0, 16));
  const parsed: unknown = JSON.parse(plain);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("qodercli credential store is not an object");
  }
  return { machineId, record: parsed as Record<string, unknown> };
}

/** Decrypt and parse `<configDir>/.auth/user`. Missing files surface as ENOENT. */
export function readQoderStore(configDir: string): QoderStoredCredentials {
  const { record } = readStoreRecord(configDir);
  return {
    ...(storedString(record, "access_token") ? { accessToken: storedString(record, "access_token") } : {}),
    ...(storedString(record, "security_oauth_token")
      ? { securityOauthToken: storedString(record, "security_oauth_token") }
      : {}),
    ...(storedString(record, "refresh_token") ? { refreshToken: storedString(record, "refresh_token") } : {}),
    ...(storedNumber(record, "expire_time") ? { expireTime: storedNumber(record, "expire_time") } : {}),
    ...(storedNumber(record, "refresh_token_expire_time")
      ? { refreshExpireTime: storedNumber(record, "refresh_token_expire_time") }
      : {}),
    ...(storedString(record, "uid") ? { uid: storedString(record, "uid") } : {}),
    ...(storedString(record, "email") ? { email: storedString(record, "email") } : {}),
  };
}

/**
 * Identity `prepareInferRequest` hashes. Missing files return undefined so a
 * PAT-only process can still build an anonymous context.
 */
export function readQoderSigningIdentity(configDir: string): QoderSigningIdentity | undefined {
  try {
    const { machineId, record } = readStoreRecord(configDir);
    if (!machineId) return undefined;
    const userInfo: Record<string, unknown> = {};
    for (const field of SIGNING_USER_FIELDS) {
      if (record[field] !== undefined) userInfo[field] = record[field];
    }
    if (typeof userInfo.uid !== "string") userInfo.uid = "";
    if (typeof userInfo.encrypt_user_info !== "string") userInfo.encrypt_user_info = "";
    if (typeof userInfo.key !== "string") userInfo.key = "";
    return { machineId, userInfoJson: JSON.stringify(userInfo) };
  } catch {
    return undefined;
  }
}
