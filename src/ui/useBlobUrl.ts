import { useEffect, useState } from "react";
import { loadBlob } from "../state/store";

const cache = new Map<string, string>();

/** Object URL for a stored file; null while loading, "" when the file is not on this device. */
export function useBlobUrl(blobId: string | undefined, mime: string): string | null {
  const [url, setUrl] = useState<string | null>(blobId ? (cache.get(blobId) ?? null) : null);
  useEffect(() => {
    if (!blobId) return;
    const hit = cache.get(blobId);
    if (hit) {
      setUrl(hit);
      return;
    }
    let alive = true;
    setUrl(null);
    loadBlob(blobId)
      .then((bytes) => {
        if (!alive) return;
        if (!bytes) return setUrl("");
        const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
        cache.set(blobId, u);
        if (cache.size > 80) {
          const first = cache.keys().next().value as string;
          URL.revokeObjectURL(cache.get(first)!);
          cache.delete(first);
        }
        setUrl(u);
      })
      .catch(() => alive && setUrl(""));
    return () => {
      alive = false;
    };
  }, [blobId, mime]);
  return url;
}
