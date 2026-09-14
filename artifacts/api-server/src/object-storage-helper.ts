import { objectStorageClient } from "./replit_integrations/object_storage";
import fs from "fs";
import path from "path";

const BUCKET_ID = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID || "";
const PRIVATE_DIR = process.env.PRIVATE_OBJECT_DIR || "";

function getBucket() {
  if (!BUCKET_ID) {
    throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  }
  const parts = PRIVATE_DIR.startsWith("/") ? PRIVATE_DIR.slice(1).split("/") : PRIVATE_DIR.split("/");
  const bucketName = parts[0] || BUCKET_ID;
  return objectStorageClient.bucket(bucketName);
}

function getObjectKey(storedName: string): string {
  const parts = PRIVATE_DIR.startsWith("/") ? PRIVATE_DIR.slice(1).split("/") : PRIVATE_DIR.split("/");
  const prefix = parts.slice(1).join("/");
  return prefix ? `${prefix}/files/${storedName}` : `.private/files/${storedName}`;
}

export async function uploadToObjectStorage(localFilePath: string, storedName: string): Promise<void> {
  try {
    const bucket = getBucket();
    const objectKey = getObjectKey(storedName);
    await bucket.upload(localFilePath, {
      destination: objectKey,
      resumable: false,
    });
  } catch (error) {
    console.error("Failed to upload to object storage:", error);
    throw error;
  }
}

export async function streamFromObjectStorage(
  storedName: string,
  res: import("express").Response,
  options: {
    contentType?: string;
    disposition?: string;
    filename?: string;
    req?: import("express").Request;
  }
): Promise<boolean> {
  try {
    const bucket = getBucket();
    const objectKey = getObjectKey(storedName);
    const file = bucket.file(objectKey);
    const [exists] = await file.exists();
    if (!exists) return false;

    const [metadata] = await file.getMetadata();
    const contentType = options.contentType || metadata.contentType || "application/octet-stream";
    const totalSize = metadata.size ? parseInt(String(metadata.size), 10) : 0;

    if (options.disposition && options.filename) {
      // RFC 5987 encoding — works for filenames with spaces and special chars in all browsers
      // Node rejects Japanese/other Unicode in the legacy filename= header.
      // Keep that fallback ASCII-only and carry the complete name in filename*=.
      const extension = options.filename.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] || "";
      const base = extension ? options.filename.slice(0, -extension.length) : options.filename;
      const safeBase = base
        .replace(/[^\x20-\x7e]/g, "")
        .replace(/"/g, '\\"')
        .trim() || "download";
      const safe = `${safeBase}${extension}`;
      const encoded = encodeURIComponent(options.filename).replace(/'/g, "%27");
      res.setHeader(
        "Content-Disposition",
        `${options.disposition}; filename="${safe}"; filename*=UTF-8''${encoded}`
      );
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");

    // Handle Range requests so video players can seek
    const rangeHeader = options.req?.headers?.range;
    if (rangeHeader && totalSize > 0) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        const chunkSize = end - start + 1;
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
        res.setHeader("Content-Length", String(chunkSize));
        const stream = file.createReadStream({ start, end });
        stream.on("error", (err) => {
          console.error("Object storage range stream error:", err);
          if (!res.headersSent) res.status(500).json({ error: "Error streaming file" });
        });
        stream.pipe(res);
        return true;
      }
    }

    if (totalSize > 0) res.setHeader("Content-Length", String(totalSize));
    const stream = file.createReadStream();
    stream.on("error", (err) => {
      console.error("Object storage stream error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Error streaming file" });
    });
    stream.pipe(res);
    return true;
  } catch (error) {
    console.error("Failed to stream from object storage:", error);
    return false;
  }
}

export async function readFileFromObjectStorage(storedName: string): Promise<Buffer | null> {
  try {
    const bucket = getBucket();
    const objectKey = getObjectKey(storedName);
    const file = bucket.file(objectKey);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [contents] = await file.download();
    return contents;
  } catch (error) {
    console.error("Failed to read from object storage:", error);
    return null;
  }
}

/**
 * Read object metadata without downloading the object body. Route handlers use
 * this for availability checks that run while a job detail screen is polling.
 */
export async function getObjectStorageMetadata(
  storedName: string,
): Promise<{ size: number; contentType?: string; md5Hash?: string; metadata?: Record<string, string> } | null> {
  try {
    const bucket = getBucket();
    const objectKey = getObjectKey(storedName);
    const file = bucket.file(objectKey);
    const [metadata] = await file.getMetadata();
    return {
      size: Number(metadata.size || 0),
      contentType: metadata.contentType || undefined,
      md5Hash: metadata.md5Hash || undefined,
      metadata: metadata.metadata || undefined,
    };
  } catch (error) {
    console.error("Failed to read object metadata:", error);
    return null;
  }
}

export async function writeFileToObjectStorage(storedName: string, content: Buffer | string): Promise<void> {
  try {
    const bucket = getBucket();
    const objectKey = getObjectKey(storedName);
    const file = bucket.file(objectKey);
    await file.save(typeof content === "string" ? Buffer.from(content, "utf-8") : content, {
      resumable: false,
    });
  } catch (error) {
    console.error("Failed to write to object storage:", error);
    throw error;
  }
}

export async function deleteFromObjectStorage(storedName: string): Promise<void> {
  try {
    const bucket = getBucket();
    const objectKey = getObjectKey(storedName);
    const file = bucket.file(objectKey);
    const [exists] = await file.exists();
    if (exists) {
      await file.delete();
    }
  } catch (error) {
    console.error("Failed to delete from object storage:", error);
  }
}

export async function deleteFromObjectStorageStrict(storedName: string): Promise<void> {
  const bucket = getBucket();
  const objectKey = getObjectKey(storedName);
  const file = bucket.file(objectKey);
  const [exists] = await file.exists();
  if (exists) await file.delete();
}

export async function getObjectStorageSignedUrl(
  storedName: string,
  expiresInSeconds: number = 3600
): Promise<string | null> {
  try {
    const bucket = getBucket();
    const objectKey = getObjectKey(storedName);
    const file = bucket.file(objectKey);
    const [exists] = await file.exists();
    if (!exists) {
      console.warn(`[signedUrl] File not found in object storage: ${objectKey}`);
      return null;
    }

    const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
    const bucketParts = PRIVATE_DIR.startsWith("/") ? PRIVATE_DIR.slice(1).split("/") : PRIVATE_DIR.split("/");
    const bucketName = bucketParts[0] || BUCKET_ID;

    const response = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketName,
        object_name: objectKey,
        method: "GET",
        expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      }),
    });

    if (!response.ok) {
      console.error(`[signedUrl] Sidecar returned ${response.status}`);
      return null;
    }

    const { signed_url: signedUrl } = await response.json();
    return signedUrl ?? null;
  } catch (error) {
    console.error("Failed to generate signed URL:", error);
    return null;
  }
}

export async function getObjectStorageUploadSignedUrl(
  storedName: string,
  expiresInSeconds: number = 15 * 60,
): Promise<string> {
  const objectKey = getObjectKey(storedName);
  const bucketParts = PRIVATE_DIR.startsWith("/") ? PRIVATE_DIR.slice(1).split("/") : PRIVATE_DIR.split("/");
  const bucketName = bucketParts[0] || BUCKET_ID;
  const response = await fetch("http://127.0.0.1:1106/object-storage/signed-object-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectKey,
      method: "PUT",
      expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`Object storage upload authorization failed (${response.status})`);
  }
  const body = await response.json() as { signed_url?: string };
  if (!body.signed_url) throw new Error("Object storage upload authorization was empty");
  return body.signed_url;
}

export function isObjectStorageConfigured(): boolean {
  return !!(BUCKET_ID && PRIVATE_DIR);
}
