interface StorageConfig {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  presignedGetTtlSeconds: number;
}

describe('storageConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const loadConfig = (): StorageConfig => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./storage.config') as { default: () => StorageConfig };
    return mod.default();
  };

  it('should read all env variables', () => {
    process.env.S3_ENDPOINT = 'http://custom:9000';
    process.env.S3_PUBLIC_ENDPOINT = 'http://public:9000';
    process.env.S3_REGION = 'eu-west-1';
    process.env.S3_ACCESS_KEY = 'mykey';
    process.env.S3_SECRET_KEY = 'mysecret';
    process.env.S3_BUCKET = 'my-bucket';
    process.env.S3_PRESIGNED_GET_TTL_SECONDS = '3600';

    const config = loadConfig();

    expect(config.endpoint).toBe('http://custom:9000');
    expect(config.publicEndpoint).toBe('http://public:9000');
    expect(config.region).toBe('eu-west-1');
    expect(config.accessKey).toBe('mykey');
    expect(config.secretKey).toBe('mysecret');
    expect(config.bucket).toBe('my-bucket');
    expect(config.presignedGetTtlSeconds).toBe(3600);
  });

  it('should apply defaults for TTL (14400s = 4h)', () => {
    delete process.env.S3_PRESIGNED_GET_TTL_SECONDS;

    const config = loadConfig();

    expect(config.presignedGetTtlSeconds).toBe(14400);
  });

  it('should default endpoint to http://minio:9000', () => {
    delete process.env.S3_ENDPOINT;

    const config = loadConfig();

    expect(config.endpoint).toBe('http://minio:9000');
  });
});
