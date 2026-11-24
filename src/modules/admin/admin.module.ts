import { Module } from '@nestjs/common';

import { AdminsController, AdminsService } from './admins';
import { DashboardController, DashboardService } from './dashboard';
import { MediaController, MediaService } from './media';
import { MembersController, MembersService } from './members';
import { AuditLogsController, NotificationTemplatesController, NotificationTemplatesService } from './notifications-audit';

@Module({
  controllers: [
    DashboardController,
    MembersController,
    AdminsController,
    MediaController,
    NotificationTemplatesController,
    AuditLogsController,
  ],
  providers: [DashboardService, MembersService, AdminsService, MediaService, NotificationTemplatesService],
})
export class AdminModule {}
