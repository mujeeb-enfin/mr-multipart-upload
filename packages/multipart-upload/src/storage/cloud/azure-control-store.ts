// ---------------------------------------------------------------------------
// azure-control-store.ts — the library's control files (manifest, lock, head,
// activity) as block blobs in the container, behind the StorageAdapter
// interface, so the manifest, lock and sweep logic runs unchanged on Azure.
// ---------------------------------------------------------------------------

import { Readable } from 'node:stream';

import type * as AzureBlob from '@azure/storage-blob';

import type { StorageAdapter, StoredObjectInfo } from '../adapter.js';

export function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number } | null)?.statusCode;
}

export function toBuffer(data: Uint8Array | string): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

async function collect(stream: NodeJS.ReadableStream | undefined): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

export class AzureControlStore implements StorageAdapter {
  constructor(
    private readonly container: AzureBlob.ContainerClient,
    private readonly prefix: string,
  ) {}

  private blob(key: string): AzureBlob.BlockBlobClient {
    return this.container.getBlockBlobClient(`${this.prefix}${key}`);
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    try {
      const props = await this.blob(key).getProperties();
      return { size: props.contentLength ?? 0, modifiedMs: props.lastModified?.getTime() ?? 0, isDirectory: false };
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
    for await (const item of this.container.listBlobsFlat({ prefix: `${this.prefix}${key}/` })) {
      return { size: 0, modifiedMs: item.properties.lastModified?.getTime() ?? 0, isDirectory: true };
    }
    return null;
  }

  async list(dirKey: string): Promise<string[]> {
    const prefix = `${this.prefix}${dirKey}/`;
    const names: string[] = [];
    for await (const item of this.container.listBlobsByHierarchy('/', { prefix })) {
      const name = item.kind === 'prefix' ? item.name.slice(prefix.length, -1) : item.name.slice(prefix.length);
      if (name) names.push(name);
    }
    return names;
  }

  async readJson<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse((await this.blob(key).downloadToBuffer()).toString('utf8')) as T;
    } catch (err) {
      if (statusOf(err) === 404 || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  async createExclusive(key: string, data: Uint8Array | string): Promise<'created' | 'exists'> {
    const body = toBuffer(data);
    try {
      await this.blob(key).upload(body, body.byteLength, { conditions: { ifNoneMatch: '*' } });
      return 'created';
    } catch (err) {
      if (statusOf(err) === 409 || statusOf(err) === 412) return 'exists';
      throw err;
    }
  }

  async write(key: string, data: Uint8Array | string): Promise<void> {
    const body = toBuffer(data);
    await this.blob(key).upload(body, body.byteLength);
  }

  async remove(key: string): Promise<void> {
    await this.blob(key).deleteIfExists();
  }

  async removeTree(dirKey: string): Promise<void> {
    const names: string[] = [];
    for await (const item of this.container.listBlobsFlat({ prefix: `${this.prefix}${dirKey}/` })) names.push(item.name);
    for (const name of names) await this.container.getBlockBlobClient(name).deleteIfExists();
  }

  async readHead(key: string, byteCount: number): Promise<Uint8Array> {
    if (byteCount <= 0) return new Uint8Array(0);
    try {
      const res = await this.blob(key).download(0, byteCount);
      return await collect(res.readableStreamBody);
    } catch (err) {
      if (statusOf(err) === 416) return new Uint8Array(0); // empty blob
      throw err;
    }
  }

  async assemble(): Promise<never> {
    throw new Error('Azure control store does not assemble files; parts use Put Block / Put Block List.');
  }

  async promote(): Promise<never> {
    throw new Error('Azure control store does not move files.');
  }

  openRead(key: string): ReadableStream<Uint8Array> {
    const blob = this.blob(key);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!reader) {
          const res = await blob.download();
          const body = res.readableStreamBody;
          if (!body) return controller.close();
          reader = (Readable.toWeb(body as Readable) as ReadableStream<Uint8Array>).getReader();
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel(reason) {
        await reader?.cancel(reason);
      },
    });
  }
}
