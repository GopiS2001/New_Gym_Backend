/**
 * Targeted, idempotent seed for onboarding lookups only: experience levels and
 * onboarding options (gender / activity / motivation). Safe for production:
 * existing rows are never modified, nothing is deleted, no admin user is created.
 *
 *   DATABASE_URL="mysql://..." npx tsx prisma/seed-onboarding.ts
 */
import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const slug = (s: string) =>
  s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function main() {
  const host = (process.env.DATABASE_URL ?? '').replace(/^.*@/, '').replace(/\?.*$/, '');
  console.log(`Target database: ${host || '(DATABASE_URL not set)'}`);

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

  const [lv, opt] = await Promise.all([prisma.experienceLevel.count(), prisma.onboardingOption.groupBy({ by: ['group'], _count: true })]);
  console.log(`Experience levels: ${lv}`);
  for (const g of opt) console.log(`Onboarding options ${g.group}: ${g._count}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
