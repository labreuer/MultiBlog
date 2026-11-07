import type { ChipKind } from "./types";
import { mentionKind } from "./kinds/mention";

// The chip kinds this build knows (docs/ENTITY_CHIPS.md, "The kind
// contract"). A chip whose kind isn't here is one a newer build wrote: it is
// kept exactly as it is and shown as a neutral placeholder, never dropped.
//
// Typed loosely on purpose. Each kind is checked against `ChipKind` with its
// own types where it is defined; here they meet as kinds of unknown data,
// and `validate` is what turns a chip's `data` into the type its kind's
// other functions take.
const KINDS: Record<string, ChipKind> = {
  [mentionKind.name]: mentionKind as unknown as ChipKind,
};

export function chipKind(name: string): ChipKind | null {
  return Object.hasOwn(KINDS, name) ? KINDS[name] : null;
}

export function chipKinds(): ChipKind[] {
  return Object.values(KINDS);
}
