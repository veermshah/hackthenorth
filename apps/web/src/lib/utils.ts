type ClassValue = string | number | null | boolean | undefined | ClassValue[];

/** Joins truthy class name fragments; nested arrays are flattened. No Tailwind class
 * de-duplication (we don't have conflicting utility pairs to merge), so no extra
 * dependency is needed for that. */
export function cn(...inputs: ClassValue[]): string {
  const flat: string[] = [];
  const walk = (value: ClassValue) => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach(walk);
    flat.push(String(value));
  };
  inputs.forEach(walk);
  return flat.join(" ");
}
