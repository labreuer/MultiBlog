import StarterKit from "@tiptap/starter-kit";
import { getSchema } from "@tiptap/core";

// The node/mark schema used for a post's content. Shared between the
// editor, the Hocuspocus doc-seeding step, and the public renderer so
// they can never drift out of sync with each other.
export const contentExtensions = [StarterKit];

// The same schema as a plain prosemirror-model Schema, for code that walks
// or diffs docs outside a live editor instance (anchor remapping, detached
// thread context) — also shared so it can't drift from contentExtensions.
export const pmSchema = getSchema(contentExtensions);
