import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let channelId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.save(
      userRepo.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `vid_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const channel = await createChannel();
    channelId = channel.id;
  });

  function buildVideo(overrides: Partial<Video> = {}): Video {
    return videoRepository.create({
      public_id: `test${counter.toString().padStart(8, '0')}`,
      channel_id: channelId,
      title: 'Test Video',
      mime_type: 'video/mp4',
      size_in_bytes: 1024,
      storage_key: 'videos/test/original.mp4',
      ...overrides,
    });
  }

  it('should default status to draft', async () => {
    const video = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce unique public_id constraint', async () => {
    await videoRepository.save(buildVideo({ public_id: 'duplicate123' }));

    await expect(
      videoRepository.save(buildVideo({ public_id: 'duplicate123' })),
    ).rejects.toThrow();
  });

  it('should enforce FK on channel_id', async () => {
    const video = buildVideo({
      channel_id: '00000000-0000-0000-0000-000000000000',
    });

    await expect(videoRepository.save(video)).rejects.toThrow();
  });

  it('should return size_in_bytes as a number (bigint transformer)', async () => {
    const largeSize = 5_368_709_120; // 5 GiB
    const video = await videoRepository.save(
      buildVideo({ size_in_bytes: largeSize }),
    );

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.size_in_bytes).toBe(largeSize);
    expect(typeof found.size_in_bytes).toBe('number');
  });

  it('should return duration_seconds as a number (numeric transformer)', async () => {
    const video = await videoRepository.save(
      buildVideo({ duration_seconds: 123.456 }),
    );

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.duration_seconds).toBeCloseTo(123.456, 3);
    expect(typeof found.duration_seconds).toBe('number');
  });

  it('should store and retrieve metadata as jsonb', async () => {
    const metadata = {
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      bit_rate: 5_000_000,
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    };
    const video = await videoRepository.save(buildVideo({ metadata }));

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.metadata).toEqual(metadata);
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const video = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOne({
      where: { id: video.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channelId);
  });
});
