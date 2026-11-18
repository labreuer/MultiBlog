import type { ReactNode } from "react";
import DiffIndexesProvider from "@/components/DiffSliders";

// docs/FORKS.md "Sliders on the diff page" — what is kept above the diff
// page: each doc's index of versions, which a slider's first touch fetches,
// and the worker that holds each doc's log and builds a version from it. A
// link from one diff to another ("Swap sides") mounts everything under
// `[left]/[right]` anew, and both are still here for it.
export default function DiffLayout({ children }: { children: ReactNode }) {
  return <DiffIndexesProvider>{children}</DiffIndexesProvider>;
}
