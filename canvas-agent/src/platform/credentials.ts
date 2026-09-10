import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]+$/);
export class ChannelVault {
    constructor(readonly root: string, readonly key: Buffer) { if (key.length !== 32) throw new Error("PLATFORM_ENCRYPTION_KEY 必须为 32 字节的十六进制编码"); }
    async save(owner: string, apiKey: string) {
        id.parse(owner);
        z.string().trim().min(1).parse(apiKey);
        const revision = randomUUID(), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
        cipher.setAAD(Buffer.from(`${owner}:${revision}`));
        const encrypted = Buffer.concat([cipher.update(apiKey.trim(), "utf8"), cipher.final()]);
        const folder = path.join(this.root, owner);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(path.join(folder, `${revision}.json`), JSON.stringify({ iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), value: encrypted.toString("hex") }), { flag: "wx", mode: 0o600 });
        const tmp = path.join(folder, `${revision}.tmp`);
        await writeFile(tmp, JSON.stringify({ revision }), { flag: "wx", mode: 0o600 });
        await rename(tmp, path.join(folder, "current.json"));
    }
    async current(owner: string): Promise<string> { return JSON.parse(await readFile(path.join(this.root, id.parse(owner), "current.json"), "utf8")).revision; }
    async get(owner: string, revision: string) {
        const data = JSON.parse(await readFile(path.join(this.root, id.parse(owner), `${id.parse(revision)}.json`), "utf8"));
        const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(data.iv, "hex"));
        decipher.setAAD(Buffer.from(`${owner}:${revision}`));
        decipher.setAuthTag(Buffer.from(data.tag, "hex"));
        return Buffer.concat([decipher.update(Buffer.from(data.value, "hex")), decipher.final()]).toString("utf8");
    }
}
