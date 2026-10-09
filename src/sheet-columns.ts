/** Convert 1-based Google Sheets column positions to A1 labels. */
export function columnName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) throw new Error("Column index must be a positive integer");
  let n = index;
  let out = "";
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}
