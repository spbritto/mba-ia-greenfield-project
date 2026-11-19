/**
 * Tests run inside the nestjs-api container.
 * Presigned URLs must be reachable from within the container,
 * so S3_PUBLIC_ENDPOINT is overridden to match S3_ENDPOINT
 * (the internal MinIO address).
 */
if (process.env.S3_ENDPOINT) {
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
}
