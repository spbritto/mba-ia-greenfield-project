interface QueueConfig {
  redisHost: string;
  redisPort: number;
}

describe('queueConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const loadConfig = (): QueueConfig => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./queue.config') as { default: () => QueueConfig };
    return mod.default();
  };

  it('should read REDIS_HOST and REDIS_PORT from env', () => {
    process.env.REDIS_HOST = 'custom-redis';
    process.env.REDIS_PORT = '6380';

    const config = loadConfig();

    expect(config.redisHost).toBe('custom-redis');
    expect(config.redisPort).toBe(6380);
  });

  it('should default REDIS_HOST to redis', () => {
    delete process.env.REDIS_HOST;

    const config = loadConfig();

    expect(config.redisHost).toBe('redis');
  });

  it('should default REDIS_PORT to 6379', () => {
    delete process.env.REDIS_PORT;

    const config = loadConfig();

    expect(config.redisPort).toBe(6379);
  });
});
