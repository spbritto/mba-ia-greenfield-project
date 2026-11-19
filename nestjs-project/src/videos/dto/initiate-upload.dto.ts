import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const ALLOWED_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

const MAX_SIZE = 10_737_418_240; // 10 GiB

export class InitiateUploadDto {
  /** Original file name (max 255 characters). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file_name: string;

  /** MIME type — must be one of the supported video types. */
  @IsIn(ALLOWED_MIME_TYPES)
  mime_type: string;

  /** Declared file size in bytes (1 … 10 GiB). */
  @IsInt()
  @Min(1)
  @Max(MAX_SIZE)
  size_in_bytes: number;
}
