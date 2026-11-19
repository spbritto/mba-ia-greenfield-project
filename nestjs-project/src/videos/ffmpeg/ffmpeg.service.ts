import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';

export interface ProbeResult {
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  bit_rate: number | null;
  format_name: string | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeFormat {
  duration?: string;
  bit_rate?: string;
  format_name?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/**
 * ffmpeg/ffprobe echo the input URL in stderr. Inputs are presigned URLs
 * (internal host, access key id, signature), and stderr ends up in the
 * owner-visible error_message, so strip them before surfacing.
 */
function redactUrls(text: string, args: string[]): string {
  return args
    .filter((arg) => /^https?:\/\//.test(arg))
    .reduce((acc, url) => acc.split(url).join('<input>'), text);
}

@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  async probe(url: string): Promise<ProbeResult> {
    const stdout = await this.exec('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ]);

    const data: FfprobeOutput = JSON.parse(stdout) as FfprobeOutput;

    const streams = data.streams ?? [];
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');
    const format = data.format ?? {};

    const duration = format.duration ? Number(format.duration) : null;

    return {
      duration_seconds: duration,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      video_codec: videoStream?.codec_name ?? null,
      audio_codec: audioStream?.codec_name ?? null,
      bit_rate: format.bit_rate ? Number(format.bit_rate) : null,
      format_name: format.format_name ?? null,
    };
  }

  async extractFrame(url: string, seconds: number): Promise<Buffer> {
    const data = await this.execBuffer('ffmpeg', [
      '-v',
      'error',
      '-ss',
      String(seconds),
      '-i',
      url,
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);

    if (data.length === 0) {
      throw new Error('ffmpeg extractFrame produced no output');
    }

    return data;
  }

  private async exec(command: string, args: string[]): Promise<string> {
    return (await this.execBuffer(command, args)).toString();
  }

  private execBuffer(command: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      child.on('close', (code) => {
        if (code !== 0) {
          const stderr = redactUrls(
            Buffer.concat(stderrChunks).toString(),
            args,
          );
          this.logger.error(`${command} exited with code ${code}: ${stderr}`);
          reject(new Error(`${command} exited with code ${code}: ${stderr}`));
          return;
        }
        resolve(Buffer.concat(stdoutChunks));
      });

      child.on('error', (err) => {
        this.logger.error(`Failed to spawn ${command}: ${err.message}`);
        reject(new Error(`Failed to spawn ${command}: ${err.message}`));
      });
    });
  }
}
