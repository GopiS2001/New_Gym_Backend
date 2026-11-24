/**
 * Permission catalogue. Keys are stored in the `permissions` table by the seed
 * and checked on every admin route by PermissionsGuard (never only in the UI).
 */
export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard.view',
  USERS_VIEW: 'users.view',
  USERS_MANAGE: 'users.manage',
  USERS_EXPORT: 'users.export',
  CONTENT_VIEW: 'content.view',
  CONTENT_MANAGE: 'content.manage',
  MEDIA_MANAGE: 'media.manage',
  NOTIFICATIONS_MANAGE: 'notifications.manage',
  ADMINS_MANAGE: 'admins.manage',
  AUDIT_VIEW: 'audit.view',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DEFINITIONS: { key: PermissionKey; module: string; description: string }[] = [
  { key: PERMISSIONS.DASHBOARD_VIEW, module: 'Dashboard', description: 'View dashboard KPIs and reports' },
  { key: PERMISSIONS.USERS_VIEW, module: 'Members', description: 'View member profiles and activity' },
  { key: PERMISSIONS.USERS_MANAGE, module: 'Members', description: 'Edit members, change account status' },
  { key: PERMISSIONS.USERS_EXPORT, module: 'Members', description: 'Export member personal data' },
  { key: PERMISSIONS.CONTENT_VIEW, module: 'Content', description: 'View catalogue, programs, coaches' },
  { key: PERMISSIONS.CONTENT_MANAGE, module: 'Content', description: 'Create, edit, publish and archive content' },
  { key: PERMISSIONS.MEDIA_MANAGE, module: 'Media', description: 'Upload, replace and delete media' },
  { key: PERMISSIONS.NOTIFICATIONS_MANAGE, module: 'Notifications', description: 'Manage notification templates' },
  { key: PERMISSIONS.ADMINS_MANAGE, module: 'Administration', description: 'Manage admin users and roles' },
  { key: PERMISSIONS.AUDIT_VIEW, module: 'Administration', description: 'View audit logs' },
];

const ALL = PERMISSION_DEFINITIONS.map((p) => p.key);

export const DEFAULT_ROLES: { key: string; name: string; description: string; permissions: PermissionKey[] }[] = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    description: 'All permissions',
    permissions: ALL,
  },
  {
    key: 'content_admin',
    name: 'Content Admin',
    description: 'Exercises, categories, equipment, muscles, programs, coaches, media',
    permissions: [
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.CONTENT_VIEW,
      PERMISSIONS.CONTENT_MANAGE,
      PERMISSIONS.MEDIA_MANAGE,
      PERMISSIONS.NOTIFICATIONS_MANAGE,
    ],
  },
  {
    key: 'support_admin',
    name: 'Support Admin',
    description: 'User lookup and limited account support',
    permissions: [PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE, PERMISSIONS.CONTENT_VIEW],
  },
  {
    key: 'analyst',
    name: 'Analyst',
    description: 'Read-only dashboards and reports',
    permissions: [PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.CONTENT_VIEW],
  },
];
