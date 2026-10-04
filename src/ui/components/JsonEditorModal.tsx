import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { StorageError } from "../../storage/errors";
import { useApp } from "../app-context";
import { Banner, Button, Modal } from "./ui";

/** Raw JSON editor: fix portion ratios or step phrasing without migrations or re-seeding. */
export function JsonEditorModal({ recipeId, onClose }: { recipeId: string; onClose: () => void }) {
  const { s } = useApp();
  const [text, setText] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void s.recipes.toJson(recipeId).then((t) => alive && setText(t));
    return () => { alive = false; };
  }, [s, recipeId]);

  const save = async () => {
    try {
      await s.recipes.saveJson(text ?? "");
      onClose();
    } catch (e) {
      setErrors(e instanceof StorageError ? (e.issues.length ? e.issues.map((i) => `${i.path}: ${i.message}`) : [e.message]) : [String(e)]);
    }
  };

  return (
    <Modal title="Edit recipe JSON" onClose={onClose} wide>
      {text === null ? <div className="h-48 animate-pulse rounded-2xl bg-sunken" aria-busy="true" /> : (
        <div className="flex flex-col gap-3">
          <label htmlFor="json-editor" className="sr-only">Recipe JSON</label>
          <textarea id="json-editor" className="field" rows={16} spellCheck={false} autoComplete="off" value={text} onChange={(e) => { setText(e.target.value); setErrors([]); }} />
          {errors.length > 0 && (
            <div data-testid="editor-errors"><Banner><ul className="list-disc pl-5">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Banner></div>
          )}
          <div className="flex gap-2">
            <Button variant="primary" icon={Save} className="flex-1" onClick={save}>Save changes</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
