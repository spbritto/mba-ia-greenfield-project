import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const PUBLIC_ID_REGEX = /^[A-Za-z0-9_-]{12}$/;

@Injectable()
export class ParsePublicIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!PUBLIC_ID_REGEX.test(value)) {
      throw new BadRequestException(
        'publicId must be exactly 12 characters from [A-Za-z0-9_-]',
      );
    }
    return value;
  }
}
