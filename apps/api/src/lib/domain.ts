export function isAllowedEmail(email: unknown, domain: string): boolean {
  if (typeof email !== "string") return false;
  const at = email.trim().toLowerCase().split("@");
  return at.length === 2 && at[0].length > 0 && at[1] === domain.toLowerCase();
}
