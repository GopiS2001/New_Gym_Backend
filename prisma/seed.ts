/**
 * Idempotent seed: permissions, roles, the first Super Admin, configurable
 * reference data and a starter exercise catalogue. It creates NO members,
 * workouts or metrics — dashboards only ever show real activity.
 *
 *   npm run db:seed
 */
import 'dotenv/config';

import { Difficulty, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { DEFAULT_ROLES, PERMISSION_DEFINITIONS } from '../src/common/auth/permissions';

const prisma = new PrismaClient();

const slug = (s: string) =>
  s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function upsertBySlug<T extends { slug: string }>(model: any, rows: T[], key: 'name' | 'label' = 'name') {
  const out: Record<string, number> = {};
  for (const [i, row] of rows.entries()) {
    const data = { sortOrder: i, ...row };
    const rec = await model.upsert({ where: { slug: row.slug }, update: {}, create: data });
    out[(row as any)[key]] = rec.id;
  }
  return out;
}

async function main() {
  // ---------------------------------------------------------------- RBAC
  for (const p of PERMISSION_DEFINITIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { description: p.description, module: p.module }, create: p });
  }
  const perms = await prisma.permission.findMany();
  for (const r of DEFAULT_ROLES) {
    const role = await prisma.role.upsert({
      where: { key: r.key },
      update: { name: r.name, description: r.description, isSystem: true },
      create: { key: r.key, name: r.name, description: r.description, isSystem: true },
    });
    // Super Admin always holds every permission; other built-ins are only seeded once.
    const existing = await prisma.rolePermission.count({ where: { roleId: role.id } });
    if (r.key === 'super_admin' || existing === 0) {
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
      await prisma.rolePermission.createMany({
        data: perms.filter((p) => r.permissions.includes(p.key as any)).map((p) => ({ roleId: role.id, permissionId: p.id })),
      });
    }
  }

  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@gym.local').toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345';
  const superRole = await prisma.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      name: 'Super Admin',
      email: adminEmail,
      passwordHash: await bcrypt.hash(adminPassword, 12),
      type: 'ADMIN',
      roleId: superRole.id,
      emailVerifiedAt: new Date(),
    },
  });

  // ---------------------------------------------------------------- Reference data
  const goals = await upsertBySlug(prisma.goal, [
    { name: 'Build Muscle', slug: 'build-muscle', icon: 'solar:dumbbell-large-bold-duotone', description: 'Grow lean muscle with progressive hypertrophy training.', motivationMessage: 'Small steps. Stronger every day.' },
    { name: 'Gain Strength', slug: 'gain-strength', icon: 'solar:medal-ribbons-star-bold-duotone', description: 'Lift heavier with structured strength programming.', motivationMessage: 'Every rep builds the stronger you.' },
    { name: 'Lose Weight', slug: 'lose-weight', icon: 'solar:fire-bold-duotone', description: 'Burn fat while keeping your strength.', motivationMessage: 'Your progress starts with your next workout.' },
    { name: 'Fundamental Conditioning', slug: 'fundamental-conditioning', icon: 'solar:heart-pulse-bold-duotone', description: 'Build a solid base of fitness, mobility and endurance.', motivationMessage: 'Consistency beats intensity.' },
    { name: 'Sports Performance', slug: 'sports-performance', icon: 'solar:running-round-bold-duotone', description: 'Train power, speed and agility for your sport.', motivationMessage: 'Train like it matters — because it does.' },
  ]);

  const focus = await upsertBySlug(
    prisma.focusArea,
    ['Chest', 'Back', 'Arms', 'Shoulders', 'Abs', 'Legs', 'Glutes', 'Full Body'].map((name) => ({ name, slug: slug(name) })),
  );

  const categories = await upsertBySlug(
    prisma.exerciseCategory,
    ['Chest', 'Back', 'Biceps', 'Triceps', 'Shoulders', 'Abs', 'Legs', 'Glutes', 'Full Body', 'Cardio'].map((name) => ({
      name,
      slug: slug(name),
      description: `${name} exercises`,
    })),
  );

  const muscleRows: [string, string, string][] = [
    ['Pectoralis Major', 'Chest', 'Upper body'],
    ['Upper Chest', 'Chest', 'Upper body'],
    ['Latissimus Dorsi', 'Back', 'Upper body'],
    ['Trapezius', 'Back', 'Upper body'],
    ['Rhomboids', 'Back', 'Upper body'],
    ['Erector Spinae', 'Back', 'Core'],
    ['Anterior Deltoid', 'Shoulders', 'Upper body'],
    ['Lateral Deltoid', 'Shoulders', 'Upper body'],
    ['Posterior Deltoid', 'Shoulders', 'Upper body'],
    ['Biceps Brachii', 'Arms', 'Upper body'],
    ['Triceps Brachii', 'Arms', 'Upper body'],
    ['Forearms', 'Arms', 'Upper body'],
    ['Rectus Abdominis', 'Core', 'Core'],
    ['Obliques', 'Core', 'Core'],
    ['Quadriceps', 'Legs', 'Lower body'],
    ['Hamstrings', 'Legs', 'Lower body'],
    ['Calves', 'Legs', 'Lower body'],
    ['Gluteus Maximus', 'Glutes', 'Lower body'],
    ['Gluteus Medius', 'Glutes', 'Lower body'],
    ['Hip Flexors', 'Legs', 'Lower body'],
  ];
  const muscles: Record<string, number> = {};
  for (const [name, muscleGroup, bodyRegion] of muscleRows) {
    const m = await prisma.muscle.upsert({ where: { slug: slug(name) }, update: {}, create: { name, slug: slug(name), muscleGroup, bodyRegion } });
    muscles[name] = m.id;
  }

  const types = await upsertBySlug(prisma.exerciseType, [
    { name: 'Strength', slug: 'strength', description: 'Weighted resistance exercises', loggingFields: ['sets', 'reps', 'weight', 'rest', 'rpe', 'notes'] },
    { name: 'Cardio', slug: 'cardio', description: 'Endurance and conditioning', loggingFields: ['duration', 'distance', 'pace', 'calories', 'notes'] },
    { name: 'Bodyweight', slug: 'bodyweight', description: 'Exercises using your own body weight', loggingFields: ['sets', 'reps', 'hold', 'rest', 'notes'] },
    { name: 'Mobility', slug: 'mobility', description: 'Range of motion and joint health', loggingFields: ['sets', 'duration', 'notes'] },
    { name: 'Stretching', slug: 'stretching', description: 'Flexibility work', loggingFields: ['sets', 'duration', 'notes'] },
    { name: 'Timed Hold', slug: 'timed-hold', description: 'Isometric holds', loggingFields: ['sets', 'hold', 'rest', 'notes'] },
  ]);

  const equipment = await upsertBySlug(
    prisma.equipment,
    ['Barbell', 'Dumbbell', 'Bench', 'Cable Machine', 'Resistance Band', 'Kettlebell', 'Smith Machine', 'Pull-up Bar', 'Bodyweight', 'Treadmill', 'Leg Press Machine'].map(
      (name) => ({ name, slug: slug(name) }),
    ),
  );

  const groups = [
    { name: 'Full Gym', items: ['Barbell', 'Dumbbell', 'Bench', 'Cable Machine', 'Kettlebell', 'Smith Machine', 'Pull-up Bar', 'Bodyweight', 'Treadmill', 'Leg Press Machine', 'Resistance Band'] },
    { name: 'Home Gym', items: ['Dumbbell', 'Bench', 'Resistance Band', 'Kettlebell', 'Pull-up Bar', 'Bodyweight'] },
  ];
  for (const [i, g] of groups.entries()) {
    const group = await prisma.equipmentGroup.upsert({
      where: { slug: slug(g.name) },
      update: {},
      create: { name: g.name, slug: slug(g.name), sortOrder: i, description: `Everything typically available in a ${g.name.toLowerCase()}` },
    });
    for (const item of g.items) {
      await prisma.equipmentGroupItem.upsert({
        where: { groupId_equipmentId: { groupId: group.id, equipmentId: equipment[item] } },
        update: {},
        create: { groupId: group.id, equipmentId: equipment[item] },
      });
    }
  }

  const levels: [string, string][] = [
    ["Beginner — I'm just getting started", 'beginner'],
    ['Less than 1 month', 'less-than-1-month'],
    ['1–6 months', '1-6-months'],
    ['6–12 months', '6-12-months'],
    ['1–2 years', '1-2-years'],
    ['2+ years', '2-plus-years'],
  ];
  for (const [i, [name, s]] of levels.entries()) {
    await prisma.experienceLevel.upsert({ where: { slug: s }, update: {}, create: { name, slug: s, rank: i, sortOrder: i } });
  }

  const options: { group: 'GENDER' | 'ACTIVITY' | 'MOTIVATION'; label: string; allowsFreeText?: boolean; description?: string }[] = [
    { group: 'GENDER', label: 'Male' },
    { group: 'GENDER', label: 'Female' },
    { group: 'GENDER', label: 'Prefer not to say' },
    { group: 'GENDER', label: 'Another option', allowsFreeText: true },
    { group: 'ACTIVITY', label: 'Log My Workouts', description: 'Track sets, reps and weights quickly' },
    { group: 'ACTIVITY', label: 'Follow Workout Programs', description: 'Structured plans built by coaches' },
    { group: 'ACTIVITY', label: 'Learn New Exercises', description: 'Discover technique and variations' },
    { group: 'MOTIVATION', label: 'Stay motivated' },
    { group: 'MOTIVATION', label: 'Track my progress' },
    { group: 'MOTIVATION', label: 'Build consistency' },
    { group: 'MOTIVATION', label: 'Improve strength' },
    { group: 'MOTIVATION', label: 'Reach my fitness goal' },
  ];
  const counters: Record<string, number> = {};
  for (const o of options) {
    const order = (counters[o.group] = (counters[o.group] ?? -1) + 1);
    await prisma.onboardingOption.upsert({
      where: { group_slug: { group: o.group, slug: slug(o.label) } },
      update: {},
      create: { ...o, slug: slug(o.label), sortOrder: order },
    });
  }

  // ---------------------------------------------------------------- Starter exercises
  type Ex = {
    name: string;
    type: string;
    difficulty: Difficulty;
    categories: string[];
    focus: string[];
    primary: string[];
    secondary: string[];
    equipment: string[];
    goals: string[];
    short: string;
    steps: string[];
    tips: string[];
    mistakes: string[];
  };

  const exercises: Ex[] = [
    {
      name: 'Barbell Bench Press', type: 'Strength', difficulty: 'INTERMEDIATE', categories: ['Chest'], focus: ['Chest'],
      primary: ['Pectoralis Major'], secondary: ['Anterior Deltoid', 'Triceps Brachii'], equipment: ['Barbell', 'Bench'],
      goals: ['Build Muscle', 'Gain Strength'], short: 'The foundational horizontal press for chest strength and size.',
      steps: ['Lie on the bench with eyes under the bar and feet flat on the floor.', 'Grip the bar slightly wider than shoulder width and unrack with straight arms.', 'Lower the bar under control to the mid-chest, elbows about 45° from your torso.', 'Press the bar back up over your shoulders until your arms are straight.'],
      tips: ['Squeeze your shoulder blades together and keep them pinned.', 'Keep your wrists stacked over your elbows.'],
      mistakes: ['Bouncing the bar off the chest.', 'Flaring the elbows to 90°.'],
    },
    {
      name: 'Incline Dumbbell Press', type: 'Strength', difficulty: 'BEGINNER', categories: ['Chest'], focus: ['Chest', 'Shoulders'],
      primary: ['Upper Chest'], secondary: ['Anterior Deltoid', 'Triceps Brachii'], equipment: ['Dumbbell', 'Bench'],
      goals: ['Build Muscle'], short: 'Targets the upper chest with a free range of motion.',
      steps: ['Set the bench to 30–45° and sit with a dumbbell on each thigh.', 'Lie back and bring the dumbbells to shoulder level, palms facing forward.', 'Press the dumbbells up and slightly together until arms are extended.', 'Lower slowly to the starting position.'],
      tips: ['Keep a slight arch and your feet planted.'], mistakes: ['Setting the incline too steep, which shifts work to the shoulders.'],
    },
    {
      name: 'Push-up', type: 'Bodyweight', difficulty: 'BEGINNER', categories: ['Chest', 'Full Body'], focus: ['Chest', 'Arms'],
      primary: ['Pectoralis Major'], secondary: ['Triceps Brachii', 'Anterior Deltoid', 'Rectus Abdominis'], equipment: ['Bodyweight'],
      goals: ['Fundamental Conditioning', 'Build Muscle'], short: 'A classic bodyweight press you can do anywhere.',
      steps: ['Start in a high plank with hands just wider than shoulders.', 'Brace your core and glutes so your body forms a straight line.', 'Lower your chest towards the floor, elbows at about 45°.', 'Push the floor away to return to the start.'],
      tips: ['Elevate your hands on a bench to make it easier.'], mistakes: ['Letting the hips sag.'],
    },
    {
      name: 'Pull-up', type: 'Bodyweight', difficulty: 'INTERMEDIATE', categories: ['Back'], focus: ['Back', 'Arms'],
      primary: ['Latissimus Dorsi'], secondary: ['Biceps Brachii', 'Rhomboids', 'Forearms'], equipment: ['Pull-up Bar'],
      goals: ['Gain Strength', 'Build Muscle'], short: 'The king of upper-body pulling exercises.',
      steps: ['Hang from the bar with an overhand grip slightly wider than shoulders.', 'Pull your shoulder blades down and back.', 'Pull your chest towards the bar until your chin clears it.', 'Lower under control to a full hang.'],
      tips: ['Use a resistance band for assistance while building strength.'], mistakes: ['Kipping or swinging to get up.'],
    },
    {
      name: 'Barbell Bent-over Row', type: 'Strength', difficulty: 'INTERMEDIATE', categories: ['Back'], focus: ['Back'],
      primary: ['Latissimus Dorsi', 'Rhomboids'], secondary: ['Trapezius', 'Biceps Brachii', 'Erector Spinae'], equipment: ['Barbell'],
      goals: ['Build Muscle', 'Gain Strength'], short: 'Builds a thick, strong back.',
      steps: ['Hold the bar with a shoulder-width overhand grip.', 'Hinge at the hips until your torso is about 45° to the floor, knees soft.', 'Row the bar to your lower ribs, driving elbows back.', 'Lower the bar with control.'],
      tips: ['Keep a neutral spine throughout.'], mistakes: ['Rounding the lower back.', 'Using momentum from the legs.'],
    },
    {
      name: 'Lat Pulldown', type: 'Strength', difficulty: 'BEGINNER', categories: ['Back'], focus: ['Back'],
      primary: ['Latissimus Dorsi'], secondary: ['Biceps Brachii', 'Rhomboids'], equipment: ['Cable Machine'],
      goals: ['Build Muscle'], short: 'A machine pull that builds towards your first pull-up.',
      steps: ['Sit with thighs secured under the pads and grip the bar wide.', 'Lean back slightly and pull the bar to your upper chest.', 'Squeeze your lats at the bottom.', 'Return the bar overhead slowly.'],
      tips: ['Think about pulling with your elbows.'], mistakes: ['Pulling the bar behind the neck.'],
    },
    {
      name: 'Barbell Back Squat', type: 'Strength', difficulty: 'INTERMEDIATE', categories: ['Legs', 'Glutes'], focus: ['Legs', 'Glutes'],
      primary: ['Quadriceps', 'Gluteus Maximus'], secondary: ['Hamstrings', 'Erector Spinae'], equipment: ['Barbell'],
      goals: ['Gain Strength', 'Build Muscle', 'Sports Performance'], short: 'The fundamental lower-body strength builder.',
      steps: ['Set the bar on your upper back and step out of the rack.', 'Stand with feet shoulder-width apart, toes slightly out.', 'Brace and sit down between your hips until thighs are at least parallel.', 'Drive through the whole foot to stand back up.'],
      tips: ['Keep your knees tracking over your toes.'], mistakes: ['Heels lifting off the floor.', 'Knees caving inward.'],
    },
    {
      name: 'Romanian Deadlift', type: 'Strength', difficulty: 'INTERMEDIATE', categories: ['Legs', 'Glutes'], focus: ['Legs', 'Glutes', 'Back'],
      primary: ['Hamstrings', 'Gluteus Maximus'], secondary: ['Erector Spinae', 'Forearms'], equipment: ['Barbell'],
      goals: ['Build Muscle', 'Gain Strength'], short: 'A hip hinge that builds the hamstrings and glutes.',
      steps: ['Stand tall holding the bar at hip height.', 'Push your hips back with soft knees, sliding the bar down your thighs.', 'Lower until you feel a strong hamstring stretch, back flat.', 'Drive your hips forward to stand tall.'],
      tips: ['Keep the bar close to your legs the whole time.'], mistakes: ['Turning it into a squat by bending the knees too much.'],
    },
    {
      name: 'Dumbbell Walking Lunge', type: 'Strength', difficulty: 'BEGINNER', categories: ['Legs', 'Glutes'], focus: ['Legs', 'Glutes'],
      primary: ['Quadriceps', 'Gluteus Maximus'], secondary: ['Hamstrings', 'Gluteus Medius'], equipment: ['Dumbbell'],
      goals: ['Build Muscle', 'Lose Weight', 'Sports Performance'], short: 'Unilateral leg work for strength and balance.',
      steps: ['Stand holding a dumbbell in each hand.', 'Step forward and lower until both knees are at about 90°.', 'Push through the front heel and bring the back foot forward into the next step.', 'Alternate legs for the set.'],
      tips: ['Keep your torso upright.'], mistakes: ['Taking steps that are too short.'],
    },
    {
      name: 'Hip Thrust', type: 'Strength', difficulty: 'BEGINNER', categories: ['Glutes'], focus: ['Glutes'],
      primary: ['Gluteus Maximus'], secondary: ['Hamstrings', 'Gluteus Medius'], equipment: ['Barbell', 'Bench'],
      goals: ['Build Muscle'], short: 'The most direct way to load the glutes.',
      steps: ['Sit with your upper back against a bench and a padded bar over your hips.', 'Plant your feet hip-width apart.', 'Drive through your heels to lift your hips until your body is flat from knees to shoulders.', 'Pause and squeeze, then lower with control.'],
      tips: ['Tuck your chin and keep ribs down at the top.'], mistakes: ['Over-arching the lower back at lockout.'],
    },
    {
      name: 'Standing Overhead Press', type: 'Strength', difficulty: 'INTERMEDIATE', categories: ['Shoulders'], focus: ['Shoulders', 'Arms'],
      primary: ['Anterior Deltoid'], secondary: ['Lateral Deltoid', 'Triceps Brachii', 'Trapezius'], equipment: ['Barbell'],
      goals: ['Gain Strength', 'Build Muscle'], short: 'A full-body brace and shoulder strength staple.',
      steps: ['Hold the bar at your collarbones with a grip just outside shoulders.', 'Brace your core and squeeze your glutes.', 'Press the bar overhead, moving your head back slightly to clear it.', 'Lock out with the bar over mid-foot, then lower.'],
      tips: ['Keep your forearms vertical.'], mistakes: ['Leaning back excessively.'],
    },
    {
      name: 'Dumbbell Lateral Raise', type: 'Strength', difficulty: 'BEGINNER', categories: ['Shoulders'], focus: ['Shoulders'],
      primary: ['Lateral Deltoid'], secondary: ['Trapezius'], equipment: ['Dumbbell'],
      goals: ['Build Muscle'], short: 'Isolates the side delts for broader shoulders.',
      steps: ['Stand holding light dumbbells at your sides.', 'With a slight bend in the elbows, raise the weights out to the sides.', 'Stop at shoulder height.', 'Lower slowly.'],
      tips: ['Lead with your elbows, not your hands.'], mistakes: ['Swinging heavy weights.'],
    },
    {
      name: 'Dumbbell Biceps Curl', type: 'Strength', difficulty: 'BEGINNER', categories: ['Biceps'], focus: ['Arms'],
      primary: ['Biceps Brachii'], secondary: ['Forearms'], equipment: ['Dumbbell'],
      goals: ['Build Muscle'], short: 'The classic arm builder.',
      steps: ['Stand with dumbbells at your sides, palms forward.', 'Keeping elbows close to your body, curl the weights up.', 'Squeeze at the top.', 'Lower under control to full extension.'],
      tips: ['Keep your upper arms still.'], mistakes: ['Swinging the torso.'],
    },
    {
      name: 'Cable Triceps Pushdown', type: 'Strength', difficulty: 'BEGINNER', categories: ['Triceps'], focus: ['Arms'],
      primary: ['Triceps Brachii'], secondary: [], equipment: ['Cable Machine'],
      goals: ['Build Muscle'], short: 'Simple, effective triceps isolation.',
      steps: ['Attach a rope or bar to a high pulley.', 'Hold it with elbows pinned to your sides.', 'Extend your elbows to push the handle down.', 'Return slowly until forearms are just above parallel.'],
      tips: ['Spread the rope apart at the bottom.'], mistakes: ['Letting the elbows drift forward.'],
    },
    {
      name: 'Forearm Plank', type: 'Timed Hold', difficulty: 'BEGINNER', categories: ['Abs'], focus: ['Abs', 'Full Body'],
      primary: ['Rectus Abdominis'], secondary: ['Obliques', 'Erector Spinae'], equipment: ['Bodyweight'],
      goals: ['Fundamental Conditioning'], short: 'Builds a strong, stable core.',
      steps: ['Place forearms on the floor, elbows under shoulders.', 'Extend your legs and rise onto your toes.', 'Brace so your body is a straight line from head to heels.', 'Hold, breathing steadily.'],
      tips: ['Squeeze your glutes to protect your lower back.'], mistakes: ['Hips too high or sagging.'],
    },
    {
      name: 'Hanging Knee Raise', type: 'Bodyweight', difficulty: 'INTERMEDIATE', categories: ['Abs'], focus: ['Abs'],
      primary: ['Rectus Abdominis'], secondary: ['Hip Flexors', 'Obliques', 'Forearms'], equipment: ['Pull-up Bar'],
      goals: ['Build Muscle', 'Fundamental Conditioning'], short: 'A challenging lower-ab exercise.',
      steps: ['Hang from a bar with arms straight.', 'Brace and draw your knees up towards your chest.', 'Curl your pelvis up at the top.', 'Lower slowly without swinging.'],
      tips: ['Exhale as you lift.'], mistakes: ['Using momentum.'],
    },
    {
      name: 'Kettlebell Swing', type: 'Strength', difficulty: 'INTERMEDIATE', categories: ['Full Body', 'Glutes'], focus: ['Full Body', 'Glutes'],
      primary: ['Gluteus Maximus', 'Hamstrings'], secondary: ['Erector Spinae', 'Anterior Deltoid', 'Forearms'], equipment: ['Kettlebell'],
      goals: ['Lose Weight', 'Sports Performance', 'Fundamental Conditioning'], short: 'Explosive hip power and conditioning.',
      steps: ['Stand with feet wider than hips, kettlebell in front.', 'Hike the bell back between your legs.', 'Snap your hips forward to swing it to chest height.', 'Let it fall back and repeat the hinge.'],
      tips: ['The power comes from the hips, not the arms.'], mistakes: ['Squatting the swing instead of hinging.'],
    },
    {
      name: 'Treadmill Run', type: 'Cardio', difficulty: 'BEGINNER', categories: ['Cardio'], focus: ['Full Body', 'Legs'],
      primary: ['Quadriceps', 'Calves'], secondary: ['Hamstrings', 'Gluteus Maximus'], equipment: ['Treadmill'],
      goals: ['Lose Weight', 'Fundamental Conditioning'], short: 'Steady-state or interval running indoors.',
      steps: ['Start with a 3–5 minute walk to warm up.', 'Increase to a comfortable running pace.', 'Hold your target pace or follow intervals.', 'Finish with a 3–5 minute walk to cool down.'],
      tips: ['A 1% incline better mimics outdoor running.'], mistakes: ['Holding onto the handrails.'],
    },
    {
      name: 'World’s Greatest Stretch', type: 'Mobility', difficulty: 'BEGINNER', categories: ['Full Body'], focus: ['Full Body'],
      primary: ['Hip Flexors'], secondary: ['Hamstrings', 'Erector Spinae', 'Obliques'], equipment: ['Bodyweight'],
      goals: ['Fundamental Conditioning', 'Sports Performance'], short: 'A full-body mobility drill for warm-ups.',
      steps: ['Step into a long lunge with your right foot forward.', 'Place your left hand on the floor and drop your right elbow to the instep.', 'Rotate and reach your right arm to the ceiling.', 'Return and repeat on the other side.'],
      tips: ['Move slowly and breathe into each position.'], mistakes: ['Rushing through the rotation.'],
    },
  ];

  const exerciseIds: Record<string, number> = {};
  for (const e of exercises) {
    const s = slug(e.name);
    const existing = await prisma.exercise.findUnique({ where: { slug: s } });
    if (existing) {
      exerciseIds[e.name] = existing.id;
      continue;
    }
    const rec = await prisma.exercise.create({
      data: {
        name: e.name,
        slug: s,
        shortDescription: e.short,
        description: e.short,
        exerciseTypeId: types[e.type],
        difficulty: e.difficulty,
        instructions: e.steps,
        tips: e.tips,
        commonMistakes: e.mistakes,
        safetyNotes: 'Warm up before training. Stop immediately if you feel pain, dizziness or discomfort. This is not medical advice.',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        createdById: admin.id,
        updatedById: admin.id,
        categories: { create: e.categories.map((c) => ({ categoryId: categories[c] })) },
        focusAreas: { create: e.focus.map((f) => ({ focusAreaId: focus[f] })) },
        equipment: { create: e.equipment.map((q) => ({ equipmentId: equipment[q] })) },
        goals: { create: e.goals.map((g) => ({ goalId: goals[g] })) },
        muscles: {
          create: [
            ...e.primary.map((m) => ({ muscleId: muscles[m], role: 'PRIMARY' as const })),
            ...e.secondary.map((m) => ({ muscleId: muscles[m], role: 'SECONDARY' as const })),
          ],
        },
      },
    });
    exerciseIds[e.name] = rec.id;
  }

  const alt = async (a: string, b: string) => {
    await prisma.exerciseAlternative.upsert({
      where: { exerciseId_alternativeExerciseId: { exerciseId: exerciseIds[a], alternativeExerciseId: exerciseIds[b] } },
      update: {},
      create: { exerciseId: exerciseIds[a], alternativeExerciseId: exerciseIds[b] },
    });
  };
  await alt('Barbell Bench Press', 'Incline Dumbbell Press');
  await alt('Barbell Bench Press', 'Push-up');
  await alt('Pull-up', 'Lat Pulldown');
  await alt('Lat Pulldown', 'Pull-up');
  await alt('Barbell Back Squat', 'Dumbbell Walking Lunge');
  await alt('Romanian Deadlift', 'Hip Thrust');

  // ---------------------------------------------------------------- Starter program (draft: review before publishing)
  if (!(await prisma.program.findUnique({ where: { slug: 'foundations-full-body' } }))) {
    const day = (title: string, dayNumber: number, list: [string, number, string, number][]) => ({
      title,
      dayNumber,
      estimatedMinutes: 50,
      exercises: {
        create: list.map(([name, sets, reps, rest], sortOrder) => ({ exerciseId: exerciseIds[name], sets, reps, restSeconds: rest, sortOrder })),
      },
    });
    await prisma.program.create({
      data: {
        name: 'Foundations: Full Body',
        slug: 'foundations-full-body',
        shortDescription: 'Three full-body sessions a week to build strength and confidence in the gym.',
        description: 'A four-week introduction to barbell and dumbbell training. Each session trains the whole body with compound lifts and finishes with core work.',
        goalId: goals['Fundamental Conditioning'],
        difficulty: 'BEGINNER',
        durationWeeks: 4,
        daysPerWeek: 3,
        targetAudience: 'New lifters and anyone returning to training',
        minExperienceRank: 0,
        maxExperienceRank: 3,
        status: 'DRAFT',
        equipment: { create: ['Barbell', 'Dumbbell', 'Bench', 'Cable Machine'].map((q) => ({ equipmentId: equipment[q] })) },
        weeks: {
          create: [1, 2, 3, 4].map((weekNumber) => ({
            weekNumber,
            title: `Week ${weekNumber}`,
            workouts: {
              create: [
                day('Full Body A', 1, [['Barbell Back Squat', 3, '8', 120], ['Barbell Bench Press', 3, '8', 120], ['Lat Pulldown', 3, '10-12', 90], ['Forearm Plank', 3, '30s', 60]]),
                day('Full Body B', 3, [['Romanian Deadlift', 3, '8-10', 120], ['Standing Overhead Press', 3, '8', 120], ['Barbell Bent-over Row', 3, '10', 90], ['Hanging Knee Raise', 3, '10', 60]]),
                day('Full Body C', 5, [['Dumbbell Walking Lunge', 3, '10 each', 90], ['Incline Dumbbell Press', 3, '10-12', 90], ['Dumbbell Biceps Curl', 2, '12', 60], ['Cable Triceps Pushdown', 2, '12', 60]]),
              ],
            },
          })),
        },
      },
    });
  }

  // ---------------------------------------------------------------- Notification templates
  const templates = [
    { name: 'Workout day reminder', title: 'Time to train 💪', body: 'Your workout is scheduled for today. Small steps. Stronger every day.', type: 'REMINDER' as const, trigger: 'WORKOUT_REMINDER' as const },
    { name: 'We miss you (3 days)', title: 'Ready for your next session?', body: "It's been a few days — your progress starts with your next workout.", type: 'MOTIVATION' as const, trigger: 'INACTIVITY' as const, schedule: { inactiveDays: 3 } },
  ];
  for (const t of templates) {
    const exists = await prisma.notificationTemplate.findFirst({ where: { name: t.name } });
    if (!exists) await prisma.notificationTemplate.create({ data: { ...t, targetSegment: { remindersEnabledOnly: true } } });
  }

  console.log(`Seed complete. Super Admin: ${adminEmail}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
