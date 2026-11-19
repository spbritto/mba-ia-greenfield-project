import { ApiProperty } from '@nestjs/swagger';

class VideoMetadataDto {
  @ApiProperty({ example: 1920, nullable: true })
  width: number | null;

  @ApiProperty({ example: 1080, nullable: true })
  height: number | null;

  @ApiProperty({ example: 'h264', nullable: true })
  video_codec: string | null;

  @ApiProperty({ example: 'aac', nullable: true })
  audio_codec: string | null;

  @ApiProperty({ example: 5000000, nullable: true })
  bit_rate: number | null;

  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2', nullable: true })
  format_name: string | null;
}

export class VideoMetadataResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aBcDeFgHiJkL' })
  public_id: string;

  @ApiProperty({ format: 'uuid' })
  channel_id: string;

  @ApiProperty({ example: 'My Video' })
  title: string;

  @ApiProperty({ enum: ['draft', 'processing', 'ready', 'failed'] })
  status: string;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ example: 10485760 })
  size_in_bytes: number;

  @ApiProperty({ example: 120.5, nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({ example: 'https://minio:9000/...', nullable: true })
  thumbnail_url: string | null;

  @ApiProperty({ example: null, nullable: true })
  error_message: string | null;

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z' })
  created_at: Date;
}
