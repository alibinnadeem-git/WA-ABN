import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "baileys";

const VERSION = 1;
const ALGORITHM = "aes-256-gcm";

type Envelope = {
  __waabnEncryptedVersion: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

const queues = new Map<string, Promise<unknown>>();

function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(filePath, next);
  return next.finally(() => {
    if (queues.get(filePath) === next) queues.delete(filePath);
  });
}

export function parseAuthEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error(
      "WA_AUTH_ENCRYPTION_KEY must decode to exactly 32 bytes. Generate one with: openssl rand -base64 32",
    );
  }
  return key;
}

function aad(file: string): Buffer {
  return Buffer.from(`WA-ABN auth state:${file}`, "utf8");
}

function encryptJson(data: unknown, file: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(file));
  const plaintext = Buffer.from(JSON.stringify(data, BufferJSON.replacer), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: Envelope = {
    __waabnEncryptedVersion: VERSION,
    algorithm: ALGORITHM,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

function decryptJson(raw: string, file: string, key: Buffer): unknown {
  const parsed = JSON.parse(raw) as Envelope;
  if (
    parsed?.__waabnEncryptedVersion !== VERSION ||
    parsed.algorithm !== ALGORITHM ||
    !parsed.iv ||
    !parsed.tag ||
    !parsed.ciphertext
  ) {
    throw new Error("Not an encrypted WA-ABN auth-state envelope");
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, "base64"));
  decipher.setAAD(aad(file));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext, BufferJSON.reviver);
}

function isEncryptedEnvelope(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as Partial<Envelope>;
    return value?.__waabnEncryptedVersion === VERSION && value.algorithm === ALGORITHM;
  } catch {
    return false;
  }
}

export async function useEncryptedMultiFileAuthState(
  folder: string,
  encryptionKey: Buffer,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const folderInfo = await stat(folder).catch(() => null);
  if (folderInfo && !folderInfo.isDirectory()) {
    throw new Error(`Auth path exists but is not a directory: ${folder}`);
  }
  if (!folderInfo) await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700).catch(() => undefined);

  const fixFileName = (file?: string) => file?.replace(/\//g, "__")?.replace(/:/g, "-");

  const writeUnlocked = async (data: unknown, file: string, filePath: string) => {
    const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, encryptJson(data, file, encryptionKey), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
  };

  const writeData = async (data: unknown, file: string) => {
    const filePath = join(folder, fixFileName(file)!);
    return withFileLock(filePath, () => writeUnlocked(data, file, filePath));
  };

  const readData = async (file: string) => {
    const filePath = join(folder, fixFileName(file)!);
    return withFileLock(filePath, async () => {
      try {
        const raw = await readFile(filePath, "utf8");
        if (isEncryptedEnvelope(raw)) {
          return decryptJson(raw, file, encryptionKey);
        }

        // One-time migration from Baileys' plaintext useMultiFileAuthState format.
        const legacy = JSON.parse(raw, BufferJSON.reviver);
        await writeUnlocked(legacy, file, filePath);
        console.warn(`🔐 Migrated legacy plaintext WhatsApp auth file to encrypted storage: ${file}`);
        return legacy;
      } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        if (error instanceof SyntaxError) {
          throw new Error(`Unreadable WhatsApp auth-state file: ${file}`);
        }
        throw error;
      }
    });
  };

  const removeData = async (file: string) => {
    const filePath = join(folder, fixFileName(file)!);
    return withFileLock(filePath, async () => {
      await unlink(filePath).catch((error: any) => {
        if (error?.code !== "ENOENT") throw error;
      });
    });
  };

  const creds: AuthenticationCreds = (await readData("creds.json")) as AuthenticationCreds || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value: any = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<unknown>[] = [];
          for (const category in data) {
            const values = data[category as keyof SignalDataTypeMap];
            if (!values) continue;
            for (const id in values) {
              const value = values[id];
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
