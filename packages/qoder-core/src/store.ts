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

interface QoderAuthExports {
  memory: WasmMemory;
  credential_storage_decrypt: RetptrFn;
  credential_storage_encrypt: RetptrFn;
  model_cache_decrypt: RetptrFn;
  __wbindgen_export2: (size: number, align: number) => number;
  __wbindgen_export3: (ptr: number, oldLen: number, newLen: number, align: number) => number;
  __wbindgen_add_to_stack_pointer: (delta: number) => number;
}

const wasmGlobal = globalThis as unknown as {
  WebAssembly: {
    Module: new (bytes: Buffer) => object;
    Instance: new (module: object, imports: unknown) => { exports: Record<string, unknown> };
  };
};

// Standard wasm-bindgen object table: indices below 132 are reserved.
const HEAP: unknown[] = new Array(128).fill(undefined);
HEAP.push(undefined, null, true, false);
let heapNext = HEAP.length;

function addHeapObject(obj: unknown): number {
  if (heapNext === HEAP.length) HEAP.push(undefined);
  const idx = heapNext;
  heapNext = HEAP[idx] as number;
  HEAP[idx] = obj;
  return idx;
}

function takeObject(idx: number): unknown {
  const value = HEAP[idx];
  if (idx >= 132) {
    HEAP[idx] = heapNext;
    heapNext = idx;
  }
  return value;
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
      __wbg_set_08463b1df38a7e29(a: number, b: number, c: number): number {
        try {
          return Reflect.set(HEAP[a] as object, HEAP[b] as PropertyKey, HEAP[c]) ? 1 : 0;
        } catch {
          return 0;
        }
      },
      __wbg_getRandomValues_d49329ff89a07af1(a: number, b: number): void {
        (HEAP[a] as { getRandomValues: (array: ArrayBufferView) => ArrayBufferView }).getRandomValues(
          HEAP[b] as ArrayBufferView,
        );
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
      __wbg_require_b4edbdcf3e2a1ef0(p: number, l: number): number {
        try {
          return addHeapObject(nodeRequire(DECODER.decode(new Uint8Array(exports.memory.buffer, p, l))));
        } catch {
          return 0;
        }
      },
      __wbg_msCrypto_bd5a034af96bcba6(i: number): number {
        return addHeapObject((HEAP[i] as { msCrypto?: unknown }).msCrypto);
      },
      __wbg_randomFillSync_6c25eac9869eb53c(a: number, b: number): void {
        (HEAP[a] as { randomFillSync: (buffer: unknown) => unknown }).randomFillSync(takeObject(b));
      },
      __wbg_call_d578befcc3145dee(a: number, b: number): number {
        try {
          return addHeapObject((HEAP[a] as (arg: unknown) => unknown)(HEAP[b]));
        } catch {
          return 0;
        }
      },
      __wbg_new_with_length_9cedd08484b73942(len: number): number {
        return addHeapObject(new Uint8Array(len >>> 0));
      },
      __wbg_length_0c32cb8543c8e4c8(i: number): number {
        return (HEAP[i] as { length: number }).length;
      },
      __wbg_prototypesetcall_3e05eb9545565046(a: number, b: number, c: number, d: number): void {
        Uint8Array.prototype.set.call(HEAP[a] as Uint8Array, (HEAP[c] as Uint8Array).subarray(b >>> 0, (b + d) >>> 0));
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
        return addHeapObject(globalThis);
      },
      __wbg_static_accessor_SELF_24f78b6d23f286ea(): number {
        return addHeapObject((globalThis as unknown as Record<string, unknown>).self);
      },
      __wbg_static_accessor_GLOBAL_f2e0f995a21329ff(): number {
        return addHeapObject((globalThis as unknown as Record<string, unknown>).global);
      },
      __wbg_static_accessor_WINDOW_59fd959c540fe405(): number {
        return addHeapObject((globalThis as unknown as Record<string, unknown>).window);
      },
      __wbindgen_cast_0000000000000001(v: unknown): number {
        return addHeapObject(v);
      },
      __wbindgen_cast_0000000000000002(v: unknown): number {
        return addHeapObject(v);
      },
    },
  });
  exports = instance.exports as unknown as QoderAuthExports;
  for (const name of [
    "memory",
    "credential_storage_decrypt",
    "credential_storage_encrypt",
    "model_cache_decrypt",
    "__wbindgen_export2",
    "__wbindgen_export3",
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

/** Decrypt and parse `<configDir>/.auth/user`. Missing files surface as ENOENT. */
export function readQoderStore(configDir: string): QoderStoredCredentials {
  const encrypted = readFileSync(`${configDir}/.auth/user`, "utf8");
  const machineId = readFileSync(`${configDir}/.auth/machine_id`, "utf8").trim();
  const plain = decryptQoderStore(encrypted, machineId.slice(0, 16));
  const parsed: unknown = JSON.parse(plain);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("qodercli credential store is not an object");
  }
  const record = parsed as Record<string, unknown>;
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
