export const formatCount = (count: number, singular: string, plural: string): string | null => {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
};
