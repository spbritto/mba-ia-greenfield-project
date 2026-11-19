import { Test, TestingModule } from '@nestjs/testing';
import * as path from 'path';
import { FfmpegService } from './ffmpeg.service';

describe('FfmpegService (integration)', () => {
  let service: FfmpegService;
  const fixturePath = path.resolve(
    __dirname,
    '../../../test/fixtures/sample.mp4',
  );

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FfmpegService],
    }).compile();

    service = module.get(FfmpegService);
  });

  describe('probe', () => {
    it('should return duration approximately 2 seconds', async () => {
      const result = await service.probe(fixturePath);

      expect(result.duration_seconds).not.toBeNull();
      expect(result.duration_seconds!).toBeGreaterThanOrEqual(1.5);
      expect(result.duration_seconds!).toBeLessThanOrEqual(2.5);
    });

    it('should return video codec and dimensions', async () => {
      const result = await service.probe(fixturePath);

      expect(result.video_codec).toBe('h264');
      expect(result.width).toBe(320);
      expect(result.height).toBe(240);
    });

    it('should return audio codec', async () => {
      const result = await service.probe(fixturePath);

      expect(result.audio_codec).toBe('aac');
    });

    it('should return format metadata', async () => {
      const result = await service.probe(fixturePath);

      expect(result.bit_rate).not.toBeNull();
      expect(result.format_name).toContain('mov');
    });

    it('should throw for an invalid file', async () => {
      await expect(service.probe('/nonexistent/file.mp4')).rejects.toThrow(
        /ffprobe exited with code/,
      );
    });

    it('should redact presigned input URLs from the error message', async () => {
      // Unreachable port on the minio service: fails fast with the URL in stderr.
      const presignedUrl =
        'http://minio:1/bucket/videos/x/original.mp4?X-Amz-Credential=key&X-Amz-Signature=secret';

      const error = await service.probe(presignedUrl).then(
        () => null,
        (err: Error) => err,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error!.message).not.toContain('X-Amz-Signature');
      expect(error!.message).not.toContain('X-Amz-Credential');
    });
  });

  describe('extractFrame', () => {
    it('should return JPEG bytes', async () => {
      const buffer = await service.extractFrame(fixturePath, 0.2);

      expect(buffer.length).toBeGreaterThan(0);
      // JPEG magic bytes: 0xFF 0xD8
      expect(buffer[0]).toBe(0xff);
      expect(buffer[1]).toBe(0xd8);
    });

    it('should throw for an invalid file', async () => {
      await expect(
        service.extractFrame('/nonexistent/file.mp4', 0),
      ).rejects.toThrow(/ffmpeg exited with code/);
    });
  });
});
