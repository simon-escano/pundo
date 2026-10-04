// Physical kitchen hardware (blueprint §1).
export const HARDWARE = {
  DEFAULT_PORTIONS: 10,
  HOME_SLOTS: 8, // two 4-cavity freezer trays per dish
  TRAY_CAVITIES: 4,
  CAVITY_ML: 250,
  TRAYS_PER_DISH: 2,
  DISHES_PER_WEEK: 3,
  FREEZER_TRAYS_TOTAL: 6,
  CONTAINER_ML: 250, // RE-250 send-out container
} as const;

export const EMA_ALPHA = 0.4;

// Roller collision rules (blueprint §2A + approved sauce_base cap).
export const ROLLER_RULES = {
  MAX_PER_PROTEIN_PER_WEEK: 2,
  MAX_TOMATO_BASE_PER_WEEK: 1, // approved addition: palate-fatigue cap on sauce_base "tomato"
  COOLDOWN_WEIGHT: 0.25, // soft penalty for dishes cooked in the preceding cycle
} as const;
