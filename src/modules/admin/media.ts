import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import sharp, { FormatEnum, Metadata } from 'sharp';
import { z } from 'zod';

import { AuditService } from '../../common/audit/audit.service';
import { Actor, CurrentActor, RequirePermissions } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { zListQuery, ZodPipe } from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { paginate } from '../../common/utils/helpers';

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};
const VIDEO_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

const FOLDERS = ['exercises', 'programs', 'coaches', 'categories', 'goals', 'equipment', 'muscles', 'collections', 'avatars', 'general'] as const;

const ListSchema = zListQuery.extend({
  mediaType: z.enum(['IMAGE', 'VIDEO']).optional(),
  folder: z.enum(FOLDERS).optional(),
});
const UploadBody = z.object({
  folder: z.enum(FOLDERS).default('general'),
  altText: z.string().trim().max(255).optional(),
});
const UpdateSchema = z.object({
  altText: z.string().trim().max(255).nullish(),
  folder: z.enum(FOLDERS).optional(),
});

type UploadedMulterFile = { buffer: Buffer; mimetype: string; originalname: string; size: number };

/** Columns that can hold a media URL — used to block deleting media in use. */
const URL_COLUMNS: [string, string][] = [
  ['users', 'avatar_url'],
  ['goals', 'image_url'],
  ['focus_areas', 'image_url'],
  ['exercise_categories', 'image_url'],
  ['muscles', 'image_url'],
  ['equipment', 'image_url'],
  ['equipment_groups', 'image_url'],
  ['onboarding_options', 'image_url'],
  ['exercises', 'image_url'],
  ['exercises', 'video_url'],
  ['coaches', 'image_url'],
  ['programs', 'image_url'],
  ['workout_templates', 'image_url'],
  ['featured_collections', 'image_url'],
];

@Injectable()
export class MediaService {
  private readonly root: string;
  private readonly baseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.root = path.resolve(process.cwd(), config.get('UPLOAD_DIR', 'uploads'));
    this.baseUrl = `${config.get('MEDIA_BASE_URL') || config.get('APP_PUBLIC_URL', 'http://localhost:4100')}/uploads`;
    this.maxImage = Number(config.get('UPLOAD_MAX_IMAGE_MB', 10)) * 1024 * 1024;
    this.maxVideo = Number(config.get('UPLOAD_MAX_VIDEO_MB', 200)) * 1024 * 1024;
  }

  private readonly maxImage: number;
  private readonly maxVideo: number;

  private classify(file: UploadedMulterFile) {
    if (IMAGE_TYPES[file.mimetype]) {
      if (file.size > this.maxImage) throw new BadRequestException(`Images must be under ${this.maxImage / 1048576} MB`);
      return { mediaType: 'IMAGE' as const, ext: IMAGE_TYPES[file.mimetype] };
    }
    if (VIDEO_TYPES[file.mimetype]) {
      if (file.size > this.maxVideo) throw new BadRequestException(`Videos must be under ${this.maxVideo / 1048576} MB`);
      return { mediaType: 'VIDEO' as const, ext: VIDEO_TYPES[file.mimetype] };
    }
    throw new BadRequestException('Unsupported file type. Use JPG, PNG, WebP, AVIF, GIF, MP4, WebM or MOV.');
  }

  private async write(key: string, data: Buffer) {
    const abs = path.join(this.root, key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
  }

  /** Decodes the image (rejects files that only claim to be images) and builds a thumbnail. */
  private async processImage(buffer: Buffer, key: string) {
    let meta: Metadata;
    try {
      meta = await sharp(buffer).metadata();
    } catch {
      throw new BadRequestException('The file is not a valid image');
    }
    const thumbKey = key.replace(/\.[a-z0-9]+$/, '.thumb.webp');
    const thumb = await sharp(buffer).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    await this.write(thumbKey, thumb);
    return { width: meta.width, height: meta.height, thumbKey };
  }

  async upload(file: UploadedMulterFile | undefined, body: z.infer<typeof UploadBody>, actor: Actor) {
    if (!file) throw new BadRequestException('No file uploaded');
    const { mediaType, ext } = this.classify(file);
    const now = new Date();
    const key = `${body.folder}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ext}`;

    let metadata: Record<string, unknown> = {};
    let thumbnailUrl: string | null = null;
    if (mediaType === 'IMAGE') {
      const info = await this.processImage(file.buffer, key);
      metadata = { width: info.width, height: info.height };
      thumbnailUrl = `${this.baseUrl}/${info.thumbKey}`;
    }
    await this.write(key, file.buffer);

    const asset = await this.prisma.mediaAsset.create({
      data: {
        storageKey: key,
        publicUrl: `${this.baseUrl}/${key}`,
        thumbnailUrl,
        mediaType,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        originalName: file.originalname.slice(0, 255),
        altText: body.altText,
        folder: body.folder,
        metadata: metadata as Prisma.InputJsonValue,
        uploadedById: actor.userId,
      },
    });
    await this.audit.log({ actor, action: 'upload', entityType: 'MediaAsset', entityId: asset.id, summary: `Uploaded ${asset.originalName}`, after: asset });
    return asset;
  }

  /**
   * Replaces the file behind an asset while keeping its URL, so every entity
   * referencing it keeps working. Images are re-encoded to the original format.
   */
  async replace(id: number, file: UploadedMulterFile | undefined, actor: Actor) {
    if (!file) throw new BadRequestException('No file uploaded');
    const asset = await this.get(id);
    const { mediaType } = this.classify(file);
    if (mediaType !== asset.mediaType) throw new BadRequestException(`Replace an ${asset.mediaType.toLowerCase()} with another ${asset.mediaType.toLowerCase()}`);

    let data = file.buffer;
    let metadata = asset.metadata as Record<string, unknown> | null;
    if (mediaType === 'IMAGE') {
      const info = await this.processImage(file.buffer, asset.storageKey);
      const fmt = IMAGE_TYPES[asset.mimeType] as keyof FormatEnum;
      data = await sharp(file.buffer).rotate().toFormat((String(fmt) === 'jpg' ? 'jpeg' : fmt) as keyof FormatEnum).toBuffer();
      metadata = { ...(metadata ?? {}), width: info.width, height: info.height, replacedAt: new Date().toISOString() };
    } else if (file.mimetype !== asset.mimeType) {
      throw new BadRequestException(`Upload a ${asset.mimeType} file to replace this video`);
    }
    await this.write(asset.storageKey, data);

    const updated = await this.prisma.mediaAsset.update({
      where: { id },
      data: { sizeBytes: data.length, originalName: file.originalname.slice(0, 255), metadata: (metadata ?? undefined) as Prisma.InputJsonValue },
    });
    await this.audit.log({ actor, action: 'replace', entityType: 'MediaAsset', entityId: id, summary: `Replaced file for ${asset.publicUrl}`, before: asset, after: updated });
    return updated;
  }

  async list(q: z.infer<typeof ListSchema>) {
    const where: Prisma.MediaAssetWhereInput = {
      ...(q.mediaType ? { mediaType: q.mediaType } : {}),
      ...(q.folder ? { folder: q.folder } : {}),
      ...(q.search ? { OR: [{ originalName: { contains: q.search } }, { altText: { contains: q.search } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.mediaAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: { uploadedBy: { select: { id: true, name: true } } },
      }),
      this.prisma.mediaAsset.count({ where }),
    ]);
    return paginate(rows, total, q.page, q.limit);
  }

  async get(id: number) {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Media not found');
    return asset;
  }

  async usage(id: number) {
    const asset = await this.get(id);
    const results: { table: string; column: string; count: number }[] = [];
    for (const [table, column] of URL_COLUMNS) {
      const rows = await this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(*) AS c FROM \`${table}\` WHERE \`${column}\` = ?`,
        asset.publicUrl,
      );
      const count = Number(rows[0]?.c ?? 0);
      if (count) results.push({ table, column, count });
    }
    return { inUse: results.length > 0, references: results };
  }

  async update(id: number, input: z.infer<typeof UpdateSchema>, actor: Actor) {
    const before = await this.get(id);
    const after = await this.prisma.mediaAsset.update({ where: { id }, data: input });
    await this.audit.log({ actor, action: 'update', entityType: 'MediaAsset', entityId: id, summary: `Updated media ${before.originalName}`, before, after });
    return after;
  }

  async remove(id: number, actor: Actor) {
    const asset = await this.get(id);
    const usage = await this.usage(id);
    if (usage.inUse) {
      throw new ConflictException(
        `This file is still used (${usage.references.map((r) => `${r.table}: ${r.count}`).join(', ')}). Remove those references first.`,
      );
    }
    await this.prisma.mediaAsset.delete({ where: { id } });
    const files = [asset.storageKey, asset.storageKey.replace(/\.[a-z0-9]+$/, '.thumb.webp')];
    await Promise.all(files.map((k) => fs.rm(path.join(this.root, k), { force: true })));
    await this.audit.log({ actor, action: 'delete', entityType: 'MediaAsset', entityId: id, summary: `Deleted ${asset.originalName}`, before: asset });
    return { success: true };
  }
}

const uploadLimits = { limits: { fileSize: 250 * 1024 * 1024 } };

@ApiTags('Admin · Media')
@ApiBearerAuth()
@Controller('admin/media')
export class MediaController {
  constructor(private readonly service: MediaService) {}

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get()
  list(@Query(new ZodPipe(ListSchema)) q: z.infer<typeof ListSchema>) {
    return this.service.list(q);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get(':id/usage')
  usage(@Param('id', ParseIntPipe) id: number) {
    return this.service.usage(id);
  }

  @RequirePermissions(PERMISSIONS.MEDIA_MANAGE)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadLimits))
  @Post()
  upload(
    @UploadedFile() file: UploadedMulterFile,
    @Body(new ZodPipe(UploadBody)) body: z.infer<typeof UploadBody>,
    @CurrentActor() actor: Actor,
  ) {
    return this.service.upload(file, body, actor);
  }

  @RequirePermissions(PERMISSIONS.MEDIA_MANAGE)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadLimits))
  @Put(':id/file')
  replace(@Param('id', ParseIntPipe) id: number, @UploadedFile() file: UploadedMulterFile, @CurrentActor() actor: Actor) {
    return this.service.replace(id, file, actor);
  }

  @RequirePermissions(PERMISSIONS.MEDIA_MANAGE)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(UpdateSchema)) body: z.infer<typeof UpdateSchema>, @CurrentActor() actor: Actor) {
    return this.service.update(id, body, actor);
  }

  @RequirePermissions(PERMISSIONS.MEDIA_MANAGE)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.remove(id, actor);
  }
}
