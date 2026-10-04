import type { CutTechniqueEnum } from "../schemas/blueprint";
import type { z } from "zod";

export type CutTechnique = z.infer<typeof CutTechniqueEnum>;
export type CutLabel = { label: string; verb: string; noun: string; size: string | null };

/** Display vocabulary per knife cut. Record<CutTechnique,…> forces exhaustiveness with the enum. */
export const CUT_LABELS: Record<CutTechnique, CutLabel> = {
  WHOLE: { label: "Whole", verb: "Keep", noun: "whole pieces", size: null },
  HALVED: { label: "Halved", verb: "Halve", noun: "halves", size: null },
  QUARTERED: { label: "Quartered", verb: "Quarter", noun: "quarters", size: null },
  WEDGES: { label: "Wedges", verb: "Cut", noun: "wedges", size: null },
  LARGE_DICE: { label: "Large dice", verb: "Cut", noun: "chunks", size: "≈2 cm" },
  MEDIUM_DICE: { label: "Medium dice", verb: "Dice", noun: "cubes", size: "≈1.3 cm" },
  SMALL_DICE: { label: "Small dice", verb: "Dice finely", noun: "cubes", size: "≈0.6 cm" },
  BRUNOISE: { label: "Brunoise", verb: "Dice", noun: "fine cubes", size: "≈0.3 cm" },
  MINCED: { label: "Minced", verb: "Mince", noun: "mince", size: null },
  SLICED_ROUNDS: { label: "Sliced rounds", verb: "Slice", noun: "rounds", size: null },
  SLICED_RINGS: { label: "Sliced rings", verb: "Slice", noun: "rings", size: null },
  SLICED_THIN: { label: "Sliced thin", verb: "Slice thin", noun: "slices", size: null },
  BATONNET: { label: "Batonnet", verb: "Cut", noun: "batons", size: null },
  JULIENNE: { label: "Julienne", verb: "Cut", noun: "matchsticks", size: null },
  ROLL_CUT: { label: "Roll cut", verb: "Roll-cut", noun: "pieces", size: null },
  CHIFFONADE_SHRED: { label: "Shredded", verb: "Shred", noun: "shreds", size: null },
  CRUSHED_SMASHED: { label: "Smashed", verb: "Smash", noun: "cloves", size: null },
  ROUGH_CHOP: { label: "Rough chop", verb: "Chop roughly", noun: "pieces", size: null },
  NONE: { label: "As is", verb: "Measure", noun: "portion", size: null },
  CUSTOM: { label: "Custom", verb: "Cut", noun: "pieces", size: null },
};
