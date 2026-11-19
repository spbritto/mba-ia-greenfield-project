import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { RefreshPartUrlsDto } from './dto/refresh-part-urls.dto';
import { RefreshPartUrlsResponseDto } from './dto/refresh-part-urls-response.dto';
import { VideoMetadataResponseDto } from './dto/video-metadata-response.dto';
import { ParsePublicIdPipe } from './pipes/parse-public-id.pipe';
import { VideosService } from './videos.service';

@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Creates a draft video and returns presigned URLs for multipart upload directly to object storage.',
  })
  @ApiResponse({
    status: 201,
    description:
      'Upload initiated — draft video created with presigned part URLs',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':videoId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Refresh presigned part URLs',
    description:
      'Returns fresh presigned URLs for the specified part numbers of an in-progress upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Fresh presigned part URLs',
    type: RefreshPartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller is not the video owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async refreshPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Body() dto: RefreshPartUrlsDto,
  ): Promise<RefreshPartUrlsResponseDto> {
    const part_urls = await this.videosService.refreshPartUrls(
      user.sub,
      videoId,
      dto.part_numbers,
    );
    return { part_urls };
  }

  @Post(':videoId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a multipart upload',
    description:
      'Finalizes the multipart upload, verifies the stored size, and enqueues video processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed — video moved to processing',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, upload incomplete, or size mismatch',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller is not the video owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, videoId, dto.parts);
  }

  @Delete(':videoId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort an in-progress upload',
    description:
      'Aborts the multipart upload in storage and deletes the draft video.',
  })
  @ApiResponse({
    status: 204,
    description: 'Upload aborted and draft video deleted',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller is not the video owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('videoId', ParseUUIDPipe) videoId: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, videoId);
  }

  // ── Public endpoints (optional auth) ─────────────────────────

  @Get(':publicId')
  @OptionalAuth()
  @ApiOperation({
    summary: 'Get video metadata',
    description:
      'Returns video metadata. Anonymous and non-owner users see only ready videos; the owner sees any status.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    type: VideoMetadataResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Authorization header present but token is invalid or expired',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not accessible',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideoMetadata(
    @Param('publicId', ParsePublicIdPipe) publicId: string,
    @CurrentUser() user?: JwtPayload,
  ): Promise<VideoMetadataResponseDto> {
    return this.videosService.findByPublicId(publicId, user?.sub);
  }

  @Get(':publicId/stream')
  @OptionalAuth()
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a presigned URL for the video file. The storage layer handles Range requests (206).',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to presigned stream URL',
  })
  @ApiResponse({
    status: 401,
    description: 'Authorization header present but token is invalid or expired',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not accessible',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video has not been uploaded yet (draft)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamVideo(
    @Param('publicId', ParsePublicIdPipe) publicId: string,
    @CurrentUser() user?: JwtPayload,
  ): Promise<{ url: string }> {
    const url = await this.videosService.getStreamUrl(publicId, user?.sub);
    return { url };
  }

  @Get(':publicId/download')
  @OptionalAuth()
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a presigned URL with Content-Disposition: attachment for the video file.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to presigned download URL',
  })
  @ApiResponse({
    status: 401,
    description: 'Authorization header present but token is invalid or expired',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not accessible',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video has not been uploaded yet (draft)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadVideo(
    @Param('publicId', ParsePublicIdPipe) publicId: string,
    @CurrentUser() user?: JwtPayload,
  ): Promise<{ url: string }> {
    const url = await this.videosService.getDownloadUrl(publicId, user?.sub);
    return { url };
  }
}
