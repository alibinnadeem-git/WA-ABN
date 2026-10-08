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

function decryptJson(raw: string, key: Buffer, file: string): unknown {
  const parsed = JSON.parse(raw) as Partial<Envelope> | unknown;
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as Partial<Envelope>).v === 1 &&
    (parsed as Partial<Envelope>).alg === "aes-256-gcm"
  ) {
    const envelope = parsed as Envelope;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad(file));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext, BufferJSON.reviver);
  }

  // One-time migration path from Baileys' plaintext multi-file auth state.
  return JSON.parse(raw, BufferJSON.reviver);
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
    try {
      return await withFileLock(filePath, async () => {
        const raw = await readFile(filePath, "utf8");
        const encrypted = raw.includes('"alg":"aes-256-gcm"') || raw.includes('"alg": "aes-256-gcm"');
        const value = decryptJson(raw, key, file);
        if (!encrypted) await writeData(value, file);
        return value;
      });
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
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
          const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`) as SignalDataTypeMap[typeof type] | null;
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value as any) as SignalDataTypeMap[typeof type];
            }
            data[id] = value as SignalDataTypeMap[typeof type];
          }));
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const typedCategory = category as keyof SignalDataTypeMap;
            for (const id in data[typedCategory]) {
              const value = data[typedCategory]![id];
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
