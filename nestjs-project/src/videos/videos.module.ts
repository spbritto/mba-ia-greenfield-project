import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import { VIDEOS_QUEUE } from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEOS_QUEUE }),
    ChannelsModule,
    StorageModule,
  ],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosModule {}
