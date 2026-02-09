/**
 * Central user registry - single source of truth for all user IDs and names.
 *
 * When adding a new user:
 * 1. Add their entry to USER_REGISTRY below
 * 2. Rebuild and deploy
 */

export interface UserEntry {
  id: string;
  name: string;
  fullName: string;
  status: 'active' | 'deleted';
}

const USER_REGISTRY: UserEntry[] = [
  { id: '32c7100e-c6ce-4cf8-8b64-edf4ac3b760b', name: 'jack',          fullName: 'Jack Lippold',    status: 'active' },
  { id: '81bf6a68-28fe-48ef-b257-f9ad013e6298', name: 'josh',          fullName: 'Joshua Carey',    status: 'active' },
  { id: 'fe56406b-a723-43cf-9f19-ba2ffcb135b0', name: 'miles',         fullName: 'Miles',           status: 'active' },
  { id: '38b1ec2b-7a70-4834-a48d-162b8902b0fd', name: 'kyla',          fullName: 'Kyla Warder',     status: 'active' },
  { id: '0f1195c1-6b57-4254-9871-6ef3b7fa360c', name: 'rhys',          fullName: 'Rhys Meredith',   status: 'active' },
  { id: 'e29fd082-6811-4e29-893e-64699c49e1f0', name: 'ben_lippold',   fullName: 'Ben Lippold',     status: 'active' },
  { id: '6d575ef4-7ac8-4a17-b732-e0e690986e58', name: 'david_geddes',  fullName: 'David Geddes',    status: 'active' },
  { id: 'aef3677b-afdf-4a7e-bbeb-c596f0d94d29', name: 'adnan',         fullName: 'Adnan Khan',      status: 'active' },
  { id: '5bb7d208-2baf-4c95-8aec-f28e016acedb', name: 'david_lippold', fullName: 'David Lippold',   status: 'active' },
  { id: 'f1647b02-c311-49c3-9c72-48b8fc5da350', name: 'joe_james',     fullName: 'Joe James',       status: 'active' },
  { id: '679f60a6-2e00-403b-86f1-f4696149294f', name: 'james_old',     fullName: 'Joshua Carey (old container)', status: 'deleted' },
];

/** All active user IDs */
export function getActiveUserIds(): string[] {
  return USER_REGISTRY.filter(u => u.status === 'active').map(u => u.id);
}

/** All user IDs including deleted */
export function getAllUserIds(): string[] {
  return USER_REGISTRY.map(u => u.id);
}

/** Map of userId -> short name */
export function getUserNames(): Record<string, string> {
  return Object.fromEntries(USER_REGISTRY.map(u => [u.id, u.name]));
}

/** Get display name for a userId */
export function getUserName(userId: string): string | undefined {
  return USER_REGISTRY.find(u => u.id === userId)?.name;
}

/** Get full registry (for admin API) */
export function getUserRegistry(): UserEntry[] {
  return [...USER_REGISTRY];
}

/** Look up a user by short name */
export function findUserByName(name: string): UserEntry | undefined {
  const lower = name.toLowerCase();
  return USER_REGISTRY.find(u =>
    u.name.toLowerCase() === lower ||
    u.fullName.toLowerCase() === lower ||
    u.fullName.toLowerCase().includes(lower)
  );
}
