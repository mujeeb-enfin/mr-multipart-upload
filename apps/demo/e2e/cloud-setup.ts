// ---------------------------------------------------------------------------
// cloud-setup.ts — prepare cloud storage for an e2e run
// ---------------------------------------------------------------------------
//
// The suite runs unchanged against any storage the demo's server is pointed
// at, selected with the same variables an operator would set:
//
//   MULTIPART_UPLOAD_STORAGE=aws_s3 | minio | azure_blob   (default: local)
//   MULTIPART_UPLOAD_TRANSFER=proxy | direct               (default: proxy)
//   + that storage's settings (MULTIPART_UPLOAD_S3_*, _MINIO_*, _AZURE_*)
//
// Before the run this creates the bucket / container if needed and gives it
// the CORS rule direct transfer needs: the browser PUTs parts from the app's
// origin straight to the storage. The rule is what the package README tells
// operators to configure.
// ---------------------------------------------------------------------------

export async function prepareCloudStorage(appOrigin: string): Promise<void> {
  const storage = process.env.MULTIPART_UPLOAD_STORAGE;
  if (!storage || storage === 'local') return;

  if (storage === 'azure_blob') {
    const { BlobServiceClient } = await import('@azure/storage-blob');
    const connection = process.env.MULTIPART_UPLOAD_AZURE_CONNECTION_STRING ?? process.env.AZURE_STORAGE_CONNECTION_STRING;
    const container = process.env.MULTIPART_UPLOAD_AZURE_CONTAINER;
    if (!connection || !container) throw new Error('azure_blob e2e needs MULTIPART_UPLOAD_AZURE_CONNECTION_STRING and _CONTAINER');
    const service = BlobServiceClient.fromConnectionString(connection);
    await service.getContainerClient(container).createIfNotExists();
    await service.setProperties({
      cors: [{ allowedOrigins: appOrigin, allowedMethods: 'PUT', allowedHeaders: '*', exposedHeaders: '*', maxAgeInSeconds: 600 }],
    });
    return;
  }

  const { S3Client, CreateBucketCommand, PutBucketCorsCommand } = await import('@aws-sdk/client-s3');
  const minio = storage === 'minio';
  const endpoint = minio ? process.env.MULTIPART_UPLOAD_MINIO_ENDPOINT : process.env.MULTIPART_UPLOAD_S3_ENDPOINT;
  const Bucket = minio ? process.env.MULTIPART_UPLOAD_MINIO_BUCKET : process.env.MULTIPART_UPLOAD_S3_BUCKET;
  if (!Bucket) throw new Error(`${storage} e2e needs its bucket variable`);
  const client = new S3Client({
    ...(endpoint ? { endpoint } : {}),
    region: (minio ? process.env.MULTIPART_UPLOAD_MINIO_REGION : process.env.MULTIPART_UPLOAD_S3_REGION) ?? 'us-east-1',
    forcePathStyle: true,
    ...(minio
      ? { credentials: { accessKeyId: process.env.MULTIPART_UPLOAD_MINIO_ACCESS_KEY ?? '', secretAccessKey: process.env.MULTIPART_UPLOAD_MINIO_SECRET_KEY ?? '' } }
      : {}),
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  await client.send(new CreateBucketCommand({ Bucket })).catch((err: { name?: string }) => {
    if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
  });
  await client.send(
    new PutBucketCorsCommand({
      Bucket,
      CORSConfiguration: {
        CORSRules: [{ AllowedOrigins: [appOrigin], AllowedMethods: ['PUT'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 600 }],
      },
    }),
  );
}
