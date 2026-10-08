import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "baileys";

type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

const fileLocks = new Map<string, Promise<unknown>>();

function normalizeKey(raw: string): Buffer {
  const value = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error(
      "WA_AUTH_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars or 32-byte base64).",
    );
  }
  return key;
}

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  fileLocks.set(filePath, next);
  try {
    return await next;
  } finally {
    if (fileLocks.get(filePath) === next) fileLocks.delete(filePath);
  }
}

function encryptJson(fileName: string, plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(fileName, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: EncryptedEnvelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

function decryptJson(fileName: string, envelope: EncryptedEnvelope, key: Buffer): string {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported auth-state encryption format in " + fileName);
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(Buffer.from(fileName, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath =
    filePath + "." + process.pid + "." + randomBytes(6).toString("hex") + ".tmp";
  await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600).catch(() => {});
}

function fixFileName(file: string): string {
  return file.replace(/\//g, "__").replace(/:/g, "-");
}

export async function useEncryptedMultiFileAuthState(
  folder: string,
  rawKey: string,
  options: { allowPlaintextMigration?: boolean } = {},
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const key = normalizeKey(rawKey);
  const folderInfo = await stat(folder).catch(() => null);

  if (folderInfo && !folderInfo.isDirectory()) {
    throw new Error(folder + " exists but is not a directory");
  }
  if (!folderInfo) await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700).catch(() => {});

  const writeData = async (data: unknown, file: string): Promise<void> => {
    const safeName = fixFileName(file);
    const filePath = path.join(folder, safeName);
    await withFileLock(filePath, async () => {
      const serialized = JSON.stringify(data, BufferJSON.replacer);
      await atomicWrite(filePath, encryptJson(safeName, serialized, key));
    });
  };

  const readData = async (file: string): Promise<any | null> => {
    const safeName = fixFileName(file);
    const filePath = path.join(folder, safeName);

    try {
      return await withFileLock(filePath, async () => {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<EncryptedEnvelope>;

        if (
          parsed.version === 1 &&
          parsed.algorithm === "aes-256-gcm" &&
          typeof parsed.iv === "string" &&
          typeof parsed.tag === "string" &&
          typeof parsed.ciphertext === "string"
        ) {
          const plaintext = decryptJson(safeName, parsed as EncryptedEnvelope, key);
          return JSON.parse(plaintext, BufferJSON.reviver);
        }

        if (!options.allowPlaintextMigration) {
          throw new Error(
            "Refusing plaintext WhatsApp auth state at " +
              filePath +
              ". Set WA_ALLOW_PLAINTEXT_AUTH_MIGRATION=true for one controlled migration run.",
          );
        }

        const plaintextValue = JSON.parse(raw, BufferJSON.reviver);
        const serialized = JSON.stringify(plaintextValue, BufferJSON.replacer);
        await atomicWrite(filePath, encryptJson(safeName, serialized, key));
        return plaintextValue;
      });
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };

  const removeData = async (file: string): Promise<void> => {
    const filePath = path.join(folder, fixFileName(file));
    await withFileLock(filePath, async () => {
      await unlink(filePath).catch((error: any) => {
        if (error?.code !== "ENOENT") throw error;
      });
    });
  };

  const creds: AuthenticationCreds = (await readData("creds.json")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(type + "-" + id + ".json");
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const values = data[category as keyof SignalDataTypeMap];
            if (!values) continue;
            for (const id in values) {
              const value = values[id];
              const file = category + "-" + id + ".json";
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, "creds.json"),
  };
}
