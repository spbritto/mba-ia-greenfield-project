import { ApiProperty } from '@nestjs/swagger';

class PartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 'https://minio:9000/videos/...' })
  url: string;
}

export class RefreshPartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlDto] })
  part_urls: PartUrlDto[];
}
