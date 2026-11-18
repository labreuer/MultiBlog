import type { ReactNode } from "react";
import DiffIndexesProvider from "@/components/DiffSliders";

// docs/FORKS.md "Sliders on the diff page" — the one thing kept above the
// diff page: each doc's index of versions, which a slider's first touch
// fetches. A link from one diff to another ("Swap sides") mounts everything
// under `[left]/[right]` anew, and the indexes are still here for it.
export default function DiffLayout({ children }: { children: ReactNode }) {
  return <DiffIndexesProvider>{children}</DiffIndexesProvider>;
}
