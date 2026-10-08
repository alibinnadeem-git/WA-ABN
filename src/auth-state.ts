import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "baileys";

type Envelope = {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
};

const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  fileLocks.set(path, previous.then(() => current));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function aad(file: string): Buffer {
  return Buffer.from(`WA-ABN:v1:${file}`, "utf8");
}

function encryptJson(value: unknown, key: Buffer, file: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(file));
  const plaintext = Buffer.from(JSON.stringify(value, BufferJSON.replacer), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: Envelope = {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
  return JSON.stringify(envelope);
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<Envelope>).v === 1 &&
    (value as Partial<Envelope>).alg === "aes-256-gcm"
  );
}

function decryptOrParse(raw: string, key: Buffer, file: string): { value: unknown; encrypted: boolean } {
  const parsed = JSON.parse(raw) as unknown;
  if (!isEnvelope(parsed)) {
    return { value: JSON.parse(raw, BufferJSON.reviver), encrypted: false };
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAAD(aad(file));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return { value: JSON.parse(plaintext, BufferJSON.reviver), encrypted: true };
}

/**
 * Baileys-compatible auth state encrypted at rest with AES-256-GCM.
 *
 * Existing plaintext files are transparently read once and immediately
 * rewritten in encrypted form. The encryption key must never be stored
 * inside DATA_DIR or committed to Git.
 */
export async function useEncryptedAuthState(
  folder: string,
  key: Buffer,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  if (key.length !== 32) throw new Error("WA_AUTH_ENCRYPTION_KEY must decode to exactly 32 bytes");

  const fixFileName = (file?: string) => file?.replace(/\//g, "__")?.replace(/:/g, "-");

  const writeData = async (data: unknown, file: string): Promise<void> => {
    const filePath = join(folder, fixFileName(file)!);
    await withFileLock(filePath, async () => {
      await writeFile(filePath, encryptJson(data, key, file), { mode: 0o600 });
      await chmod(filePath, 0o600).catch(() => {});
    });
  };

  const readData = async (file: string): Promise<unknown | null> => {
    const filePath = join(folder, fixFileName(file)!);
    let decoded: { value: unknown; encrypted: boolean };
    try {
      decoded = await withFileLock(filePath, async () => {
        const raw = await readFile(filePath, "utf8");
        return decryptOrParse(raw, key, file);
      });
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }

    if (!decoded.encrypted) {
      await writeData(decoded.value, file);
    }
    return decoded.value;
  };

  const removeData = async (file: string): Promise<void> => {
    const filePath = join(folder, fixFileName(file)!);
    await withFileLock(filePath, async () => {
      await unlink(filePath).catch((error: any) => {
        if (error?.code !== "ENOENT") throw error;
      });
    });
  };

  const folderInfo = await stat(folder).catch(() => null);
  if (folderInfo && !folderInfo.isDirectory()) {
    throw new Error(`${folder} exists but is not a directory`);
  }
  if (!folderInfo) await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700).catch(() => {});

  const creds = ((await readData("creds.json")) as AuthenticationCreds | null) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out: Record<string, any> = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`) as any;
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            out[id] = value;
          }));
          return out as { [id: string]: SignalDataTypeMap[typeof type] };
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const entries = (data as any)[category] as Record<string, unknown> | undefined;
            if (!entries) continue;
            for (const [id, value] of Object.entries(entries)) {
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => writeData(creds, "creds.json"),
  };
}
