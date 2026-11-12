import db, { Doc } from "./db";
import { archivePage, createPage, getPage, updatePage } from "./pages";

// The original flat Docs API, kept for existing callers (/api/docs,
// reports). Everything is a page in the Files workspace now (see pages.ts); a "doc" is just an
// active page, and deleting one moves it to the Trash.

export function listDocs(q?: string): Doc[] {
  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    return db
      .prepare(`SELECT * FROM docs WHERE status='active' AND kind != 'folder' AND (title LIKE ? OR body LIKE ?) ORDER BY updated_at DESC`)
      .all(like, like) as Doc[];
  }
  return db.prepare(`SELECT * FROM docs WHERE status='active' AND kind != 'folder' ORDER BY updated_at DESC`).all() as Doc[];
}

export function getDoc(id: number): Doc | undefined {
  const page = getPage(id);
  return page && page.status === "active" ? page : undefined;
}

export function createDoc(input: { title: string; body?: string; category?: string; created_by?: "owner" | "agent" }): Promise<Doc> {
  return createPage({ ...input, kind: "page" });
}

export function updateDoc(id: number, changes: { title?: string; body?: string; category?: string; append?: boolean }): Promise<Doc> {
  return updatePage(id, changes);
}

export function deleteDoc(id: number): { deleted: boolean } {
  return { deleted: archivePage(id).archived.length > 0 };
}
