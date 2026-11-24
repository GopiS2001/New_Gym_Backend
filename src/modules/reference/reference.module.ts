import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Type,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { Actor, CurrentActor, Public, RequirePermissions } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { ZodPipe } from '../../common/pipes/zod';
import { REFERENCE_CONFIGS, ReferenceConfig, zReferenceStatus, zReorder } from './reference.config';
import { ReferenceService } from './reference.service';

/** Builds an admin CRUD controller + a public read controller for one config. */
function buildControllers(cfg: ReferenceConfig): Type<unknown>[] {
  const createPipe = new ZodPipe(cfg.schema);
  const updatePipe = new ZodPipe(cfg.schema.partial());

  @ApiTags(`Admin · ${cfg.label}`)
  @ApiBearerAuth()
  @Controller(`admin/${cfg.path}`)
  class AdminReferenceController {
    constructor(readonly service: ReferenceService) {}

    @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
    @Get()
    list(@Query() q: Record<string, string>) {
      return this.service.list(cfg, q);
    }

    @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
    @Get(':id')
    get(@Param('id', ParseIntPipe) id: number) {
      return this.service.get(cfg, id);
    }

    @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
    @Post()
    create(@Body(createPipe) body: Record<string, unknown>, @CurrentActor() actor: Actor) {
      return this.service.create(cfg, body, actor);
    }

    @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
    @Put('reorder')
    reorder(@Body(new ZodPipe(zReorder)) body: { ids: number[] }, @CurrentActor() actor: Actor) {
      return this.service.reorder(cfg, body.ids, actor);
    }

    @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
    @Patch(':id')
    update(
      @Param('id', ParseIntPipe) id: number,
      @Body(updatePipe) body: Record<string, unknown>,
      @CurrentActor() actor: Actor,
    ) {
      return this.service.update(cfg, id, body, actor);
    }

    @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
    @Patch(':id/status')
    status(
      @Param('id', ParseIntPipe) id: number,
      @Body(new ZodPipe(zReferenceStatus)) body: { status: 'ACTIVE' | 'INACTIVE' },
      @CurrentActor() actor: Actor,
    ) {
      return this.service.setStatus(cfg, id, body.status, actor);
    }

    @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
    @Delete(':id')
    remove(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
      return this.service.remove(cfg, id, actor);
    }
  }

  @ApiTags('Discovery')
  @Controller(cfg.path)
  class PublicReferenceController {
    constructor(readonly service: ReferenceService) {}

    @Public()
    @Get()
    list(@Query() q: Record<string, string>) {
      return this.service.listActive(cfg, q);
    }
  }

  Object.defineProperty(AdminReferenceController, 'name', { value: `Admin_${cfg.model}_Controller` });
  Object.defineProperty(PublicReferenceController, 'name', { value: `Public_${cfg.model}_Controller` });

  return [AdminReferenceController, PublicReferenceController];
}

@Module({
  controllers: REFERENCE_CONFIGS.flatMap(buildControllers),
  providers: [ReferenceService],
  exports: [ReferenceService],
})
export class ReferenceModule {}
