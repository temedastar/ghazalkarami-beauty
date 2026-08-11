import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "./env";

/**
 * Any S3-compatible object storage works here (Liara Object Storage, Arvan,
 * MinIO, AWS S3, ...). When OBJECT_STORAGE_* env vars are unset, callers
 * should fall back to local disk — see routes/admin.ts — since that's fine
 * for local development but not for a PaaS app container in production,
 * where local disk isn't guaranteed to survive a plan resize or redeploy.
 */
export function isObjectStorageConfigured(): boolean {
  return Boolean(env.objectStorage.endpoint && env.objectStorage.bucket && env.objectStorage.accessKeyId);
}

let client: S3Client | null = null;
function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env.objectStorage.endpoint,
      region: env.objectStorage.region,
      credentials: {
        accessKeyId: env.objectStorage.accessKeyId,
        secretAccessKey: env.objectStorage.secretAccessKey,
      },
      forcePathStyle: true, // required by most non-AWS S3-compatible providers
    });
  }
  return client;
}

function publicUrlFor(key: string): string {
  const base = env.objectStorage.publicUrlBase || `${env.objectStorage.endpoint}/${env.objectStorage.bucket}`;
  return `${base.replace(/\/$/, "")}/${key}`;
}

export async function uploadBuffer(buffer: Buffer, key: string, contentType: string): Promise<string> {
  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: env.objectStorage.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        // deliberately no ACL here — Liara Object Storage (and several
        // other S3-compatible providers) manage public/private access as a
        // BUCKET-level setting (ObjectRead / ObjectReadWithoutList /
        // private, set in their console), not per-object ACL headers; their
        // own upload examples never send one either. A bucket that isn't
        // set to a public access level in Liara's console will still
        // upload fine but won't be reachable at the public URL below —
        // that's a console setting, not something this code can fix.
        // key is a random UUID (see routes/admin.ts) — the object at this
        // URL never changes, so it's safe to cache aggressively for a year
        CacheControl: "public, max-age=31536000, immutable",
      })
    );
  } catch (err) {
    // AWS SDK v3 errors carry the actual provider-reported reason in
    // .name/.message and the HTTP status/request id in $metadata — a plain
    // console.error(err) usually surfaces these too, but logging them as
    // explicit fields makes the real cause unmistakable in a log viewer
    // that truncates or reformats stack traces (e.g. Liara's), instead of
    // every failure looking like the same opaque object
    const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
    console.error("Object storage PutObject failed:", {
      name: e?.name,
      message: e?.message,
      httpStatusCode: e?.$metadata?.httpStatusCode,
      requestId: e?.$metadata?.requestId,
      endpoint: env.objectStorage.endpoint,
      bucket: env.objectStorage.bucket,
      region: env.objectStorage.region,
    });
    throw err;
  }
  return publicUrlFor(key);
}
