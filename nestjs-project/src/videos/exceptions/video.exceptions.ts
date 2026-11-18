import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoAccessDeniedException extends DomainException {
  constructor() {
    super('VIDEO_ACCESS_DENIED', 403, 'You do not have access to this video');
  }
}

export class VideoNotInDraftException extends DomainException {
  constructor() {
    super('VIDEO_NOT_IN_DRAFT', 409, 'Video is no longer in draft status');
  }
}

export class VideoNotUploadedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_UPLOADED', 409, 'Video has not been uploaded yet');
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_INCOMPLETE',
      400,
      'Upload is incomplete — wrong number of parts or storage rejected the part list',
    );
  }
}

export class SizeMismatchException extends DomainException {
  constructor() {
    super(
      'SIZE_MISMATCH',
      400,
      'Stored object size differs from the declared size',
    );
  }
}
