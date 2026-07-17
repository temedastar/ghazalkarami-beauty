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
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.objectStorage.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: "public-read",
      // key is a random UUID (see routes/admin.ts) — the object at this URL
      // never changes, so it's safe to cache aggressively for a full year
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
  return publicUrlFor(key);
}
