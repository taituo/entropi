import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_IMAGE = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
/** One request to a model should stay under about 10 MB of images in total. */
export const MAX_IMAGE_BYTES_PER_MESSAGE = 10 * 1024 * 1024;

/** Raster images only, decided by magic bytes, never by the filename or the client's content type. */
export function sniff(b: Buffer): { mime: string; ext: string } | undefined {
	if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
	if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
	if (b.length > 6 && b.subarray(0, 4).toString("latin1") === "GIF8") return { mime: "image/gif", ext: "gif" };
	if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
	return undefined;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Content-addressed image files on local disk. Nothing is fetched from anywhere: bytes come from uploads only. */
export function createUploads(dir: string) {
	mkdirSync(dir, { recursive: true });
	return {
		async save(bytes: Buffer): Promise<{ id: string; mime: string; size: number }> {
			if (bytes.length > MAX_IMAGE) throw new Error(`image too large (max ${Math.round(MAX_IMAGE / 1048576)} MB)`);
			const kind = sniff(bytes);
			if (!kind) throw new Error("only PNG, JPEG, GIF and WebP images are accepted");
			const id = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
			await writeFile(join(dir, `${id}.${kind.ext}`), bytes);
			return { id, mime: kind.mime, size: bytes.length };
		},
		read: (id: string, mime: string) => readFile(join(dir, `${id.replace(/[^a-f0-9]/g, "")}.${EXT[mime] ?? "bin"}`)),
	};
}
export type Uploads = ReturnType<typeof createUploads>;
