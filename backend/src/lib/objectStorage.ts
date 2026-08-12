import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
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
      forcePathStyle: true, // required by most non-AWS S3-compatible providers, including Liara
    });
  }
  return client;
}

function publicUrlFor(key: string): string {
  const base = env.objectStorage.publicUrlBase || `${env.objectStorage.endpoint}/${env.objectStorage.bucket}`;
  return `${base.replace(/\/$/, "")}/${key}`;
}

// AWS SDK v3 errors are inconsistent about exactly where the provider's real
// reason ends up — a plain S3ServiceException puts it in .name/.message, but
// some S3-compatible gateways return a body the SDK parses into a bare
// object with .Code/.message instead, and network-level failures (DNS,
// TLS, connection refused — e.g. from a malformed/protocol-less endpoint)
// throw a generic Node/undici error with none of the S3-specific fields at
// all. Pulling every shape into one flat object means a log line never
// silently omits the one field that would've explained it.
export function describeStorageError(err: unknown) {
  const e = err as {
    name?: string;
    message?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number; requestId?: string; attempts?: number };
    $response?: { statusCode?: number; body?: unknown };
    cause?: { message?: string; code?: string };
  };
  return {
    name: e?.name,
    message: e?.message,
    code: e?.Code || e?.code,
    httpStatusCode: e?.$metadata?.httpStatusCode ?? e?.$response?.statusCode,
    requestId: e?.$metadata?.requestId,
    attempts: e?.$metadata?.attempts,
    // network-level errors (ENOTFOUND, ECONNREFUSED, certificate errors from
    // a malformed endpoint, etc.) surface here instead of the fields above
    causeMessage: e?.cause?.message,
    causeCode: e?.cause?.code,
  };
}

function logStorageError(operation: string, err: unknown) {
  console.error(`Object storage ${operation} failed:`, {
    ...describeStorageError(err),
    endpoint: env.objectStorage.endpoint,
    bucket: env.objectStorage.bucket,
    region: env.objectStorage.region,
  });
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
    logStorageError("PutObject", err);
    throw err;
  }
  return publicUrlFor(key);
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: env.objectStorage.bucket, Key: key }));
  } catch (err) {
    logStorageError("DeleteObject", err);
    throw err;
  }
}

// used only by the admin panel's "تست اتصال" diagnostic button (GET
// /admin/object-storage/test) — confirms the bucket is even reachable with
// the current credentials before attempting a real upload, so a
// misconfigured endpoint/region/credentials shows up as its own distinct
// failure stage instead of being indistinguishable from a PutObject failure
export async function headBucket(): Promise<void> {
  try {
    await getClient().send(new HeadBucketCommand({ Bucket: env.objectStorage.bucket }));
  } catch (err) {
    logStorageError("HeadBucket", err);
    throw err;
  }
}
