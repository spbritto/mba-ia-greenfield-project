import { ApiProperty } from '@nestjs/swagger';

class PartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 'https://minio:9000/videos/...' })
  url: string;
}

export class InitiateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aBcDeFgHiJkL' })
  public_id: string;

  @ApiProperty({ example: 'draft' })
  status: string;

  @ApiProperty({ example: 'abc123...' })
  upload_id: string;

  @ApiProperty({ example: 104857600 })
  part_size: number;

  @ApiProperty({ example: 1 })
  total_parts: number;

  @ApiProperty({ type: [PartUrlDto] })
  part_urls: PartUrlDto[];
}
