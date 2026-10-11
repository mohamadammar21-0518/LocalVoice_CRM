/** Keep every word, including long unbroken strings, within the speech limit. */
export function speechChunks(text: string, maxLength = 1000): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 2)
    throw new Error("Invalid speech chunk limit");
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength + 1);
    const sentence = [...candidate.matchAll(/[.!?](?=\s)/g)].at(-1);
    let end = sentence ? sentence.index! + 1 : candidate.lastIndexOf(" ");
    if (end < Math.floor(maxLength / 2)) end = maxLength;
    // Do not split the two UTF-16 halves of an emoji or another supplementary character.
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
