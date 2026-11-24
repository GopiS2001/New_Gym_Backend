import { Module } from '@nestjs/common';

import { ExercisesAdminController, ExercisesAdminService } from './exercises.admin';
import { ExercisesPublicController, ExercisesPublicService } from './exercises.public';

@Module({
  controllers: [ExercisesAdminController, ExercisesPublicController],
  providers: [ExercisesAdminService, ExercisesPublicService],
  exports: [ExercisesPublicService],
})
export class ExercisesModule {}
