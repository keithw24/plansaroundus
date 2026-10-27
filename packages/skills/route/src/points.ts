// Shared waypoint cleanup for the Routes request and the Maps link.

/** A trimmed place id, or undefined when it's missing or blank. */
export function placeIdOf(p: { placeId?: string | undefined }): string | undefined {
  const id = p.placeId?.trim();
  return id ? id : undefined;
}

/** A coordinate rounded to 6 decimals (~10 cm), as a number. */
export function roundCoord(n: number): number {
  const r = Number(n.toFixed(6));
  return Object.is(r, -0) ? 0 : r;
}

/** A coordinate as plain decimal text, never "1e-7": "40.8075", "0", "-0.000005". */
export function coordText(n: number): string {
  const s = roundCoord(n).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}
