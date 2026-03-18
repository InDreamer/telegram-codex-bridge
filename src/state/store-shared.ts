export function buildInClausePlaceholders(count: number): string {
  if (count <= 0) {
    throw new Error("IN clause placeholder count must be positive");
  }

  return Array.from({ length: count }, () => "?").join(", ");
}
