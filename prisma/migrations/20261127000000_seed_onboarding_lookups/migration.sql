-- Data-only: default experience levels and onboarding options (gender / activity / motivation).
-- INSERT IGNORE skips any row whose unique slug already exists, so edits made in the
-- dashboard are kept and nothing is changed or removed.

INSERT IGNORE INTO `experience_levels` (`name`, `slug`, `rank`, `sort_order`, `status`, `created_at`, `updated_at`) VALUES
  ('Beginner — I''m just getting started', 'beginner',          0, 0, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('Less than 1 month',                    'less-than-1-month', 1, 1, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('1–6 months',                           '1-6-months',        2, 2, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('6–12 months',                          '6-12-months',       3, 3, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('1–2 years',                            '1-2-years',         4, 4, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('2+ years',                             '2-plus-years',      5, 5, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

INSERT IGNORE INTO `onboarding_options` (`group`, `label`, `slug`, `description`, `allows_free_text`, `sort_order`, `status`, `created_at`, `updated_at`) VALUES
  ('GENDER',     'Male',                    'male',                    NULL,                                    false, 0, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('GENDER',     'Female',                  'female',                  NULL,                                    false, 1, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('GENDER',     'Prefer not to say',       'prefer-not-to-say',       NULL,                                    false, 2, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('GENDER',     'Another option',          'another-option',          NULL,                                    true,  3, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('ACTIVITY',   'Log My Workouts',         'log-my-workouts',         'Track sets, reps and weights quickly',  false, 0, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('ACTIVITY',   'Follow Workout Programs', 'follow-workout-programs', 'Structured plans built by coaches',     false, 1, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('ACTIVITY',   'Learn New Exercises',     'learn-new-exercises',     'Discover technique and variations',     false, 2, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('MOTIVATION', 'Stay motivated',          'stay-motivated',          NULL,                                    false, 0, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('MOTIVATION', 'Track my progress',       'track-my-progress',       NULL,                                    false, 1, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('MOTIVATION', 'Build consistency',       'build-consistency',       NULL,                                    false, 2, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('MOTIVATION', 'Improve strength',        'improve-strength',        NULL,                                    false, 3, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('MOTIVATION', 'Reach my fitness goal',   'reach-my-fitness-goal',   NULL,                                    false, 4, 'ACTIVE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
