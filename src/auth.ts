// Demo-only login. These credentials live inside the app and are NOT real security.
interface DemoUser {
  password: string;
  displayName: string;
  role: string;
}

const USERS: Record<string, DemoUser> = {
  admin: { password: "admin123", displayName: "Administrator", role: "Admin" },
  finance: { password: "finance2026", displayName: "Finance Team", role: "Accounts Payable" },
};

export interface Session {
  username: string;
  displayName: string;
  role: string;
}

export function login(username: string, password: string): Session | null {
  const key = username.trim().toLowerCase();
  const u = USERS[key];
  if (!u || u.password !== password) return null;
  return { username: key, displayName: u.displayName, role: u.role };
}
