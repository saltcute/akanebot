import sharp from "sharp";

/** A picture's own bytes, base64 encoded, small enough to be cheap to show a model. */
export type InlineImage = { data: string; mediaType: string };

const WEBP_QUALITY = 80;

/**
 * A model charges for a picture by its area, and a phone screenshot is several times larger than it needs to be to read.
 * Never enlarges. An animation becomes its first frame. Returns undefined for anything that can't be decoded.
 */
export async function shrinkImage(bytes: Uint8Array, maxEdge: number): Promise<InlineImage | undefined> {
    try {
        const small = await sharp(bytes)
            .rotate()
            .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
            .webp({ quality: WEBP_QUALITY })
            .toBuffer();
        return { data: small.toString("base64"), mediaType: "image/webp" };
    } catch {
        return undefined;
    }
}
