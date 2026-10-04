import { z } from "zod";
import { RecipeSchema, CutTechniqueEnum } from "../schemas/blueprint";

/** Text copied to the clipboard by [Copy Schema & LLM Prompt]. Pure: the LLM runs outside the app. */
export function buildLlmPrompt(knownIngredientIds: readonly string[] = []): string {
  const schema = JSON.stringify(z.toJSONSchema(RecipeSchema), null, 2);
  return [
    "Convert the recipe I give you into ONE JSON object that validates against this JSON Schema.",
    "Output raw JSON only: no markdown fences, no commentary.",
    "",
    "Rules:",
    "- default_portions is always 10. Every quantity_per_portion is for ONE portion.",
    "- ingredient_id is snake_case and stable (red_onion, pork_shoulder). Reuse these ids when they match: " +
      (knownIngredientIds.length ? knownIngredientIds.join(", ") : "(none yet)") + ".",
    "- NEVER include price or cost fields on prep_items. Prices live in a separate registry.",
    `- cut_technique must be one of: ${CutTechniqueEnum.options.join(", ")}.`,
    "- granularity: discrete = countable pieces (1 to 6 per portion, pieces_per_portion is an integer);",
    "  granular = sliced or segmented (pieces_per_portion may be null); continuous = ground meat, sauces, liquids (pieces_per_portion is null).",
    "- Use NONE for liquids, pastes and ground meat. CUSTOM requires cut_note.",
    "- packaging: set retail_unit, pack_size (in the item's unit) and snap_to_whole_pack for canned, bottled or pouched items.",
    "- cook_steps are action verbs and sensory cues ONLY: no numbers, times, temperatures or measurements.",
    "- estimated_base_cost_php is a rough PHP total for 10 portions (cold-start fallback only).",
    "",
    "JSON Schema:",
    schema,
  ].join("\n");
}
