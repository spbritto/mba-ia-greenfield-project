import { ArrayNotEmpty, IsArray, IsInt, Min } from 'class-validator';
import { ArrayUnique } from 'class-validator';

export class RefreshPartUrlsDto {
  /** Part numbers to refresh — unique integers >= 1. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
