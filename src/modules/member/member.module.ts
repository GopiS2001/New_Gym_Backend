import { Module } from '@nestjs/common';

import { LibraryController, LibraryService } from './library';
import { OnboardingController, ProfileController, ProfileService } from './profile';
import { WorkoutsController, WorkoutsService } from './workouts';

@Module({
  controllers: [OnboardingController, ProfileController, LibraryController, WorkoutsController],
  providers: [ProfileService, LibraryService, WorkoutsService],
})
export class MemberModule {}
