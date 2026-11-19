import { ApiProperty } from '@nestjs/swagger';

export class CompleteUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aBcDeFgHiJkL' })
  public_id: string;

  @ApiProperty({ example: 'processing' })
  status: string;
}
